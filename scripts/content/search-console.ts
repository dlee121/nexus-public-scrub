/**
 * Google Search Console lifetime report.
 *
 * Per site emits:
 *   - Lifetime article count (from the WordPress REST API X-WP-Total
 *     header — published/*.json files are NOT source of truth).
 *   - Lifetime totals (one aggregated row from a no-dimension GSC call;
 *     captures the long tail).
 *   - Top 10 queries by impressions over the lifetime window.
 *   - Top 5 pages by impressions over the lifetime window.
 *
 * Window covers the full GSC retention horizon — today minus 16 months
 * to today. GSC silently zeros any period before property verification,
 * so requesting more than the property has does no harm.
 *
 * Output is Telegram-MarkdownV1 (`*bold*`) — no tables.
 */

import { createSign } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { sendTelegram } from "./telegram";

const ENV_PATH = join(import.meta.dir, "../../data/content/.env");

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const content = readFileSync(ENV_PATH, "utf8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)/);
      if (match) env[match[1]] = match[2].trim();
    }
  } catch {}
  return env;
}

async function getAccessToken(
  key: Record<string, string>,
  scope = "https://www.googleapis.com/auth/webmasters.readonly"
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iss: key.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign
    .sign(key.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${payload}.${sig}`,
    }),
  });

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (data.error || !data.access_token)
    throw new Error(`Token error: ${data.error}`);
  return data.access_token;
}

interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SiteTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SiteResult {
  name: string;
  siteUrl: string;
  domain: string;
  publishedLifetime: number | null; // null = WP API failed; renders as "?"
  totals: SiteTotals;
  topKeywords: SearchRow[];
  topPages: SearchRow[];
}

const ZERO_TOTALS: SiteTotals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

async function queryGsc(
  token: string,
  siteUrl: string,
  body: Record<string, unknown>,
): Promise<SearchRow[]> {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json()) as { rows?: SearchRow[]; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.rows || [];
}

async function fetchSiteTotals(
  token: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<SiteTotals> {
  // No `dimensions` → GSC returns a single aggregated row covering the
  // FULL long tail. Summing top-N query rows (the previous behavior) only
  // captured a fraction of true impressions.
  const rows = await queryGsc(token, siteUrl, { startDate, endDate, rowLimit: 1 });
  const r = rows[0];
  if (!r) return ZERO_TOTALS;
  return {
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  };
}

async function fetchTopKeywords(
  token: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<SearchRow[]> {
  // rowLimit 100 gives GSC plenty of headroom to choose meaningful keywords;
  // we surface the top 10 by impressions afterwards.
  const rows = await queryGsc(token, siteUrl, {
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: 100,
    startRow: 0,
  });
  return rows
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10);
}

async function fetchTopPages(
  token: string,
  siteUrl: string,
  startDate: string,
  endDate: string,
): Promise<SearchRow[]> {
  const rows = await queryGsc(token, siteUrl, {
    startDate,
    endDate,
    dimensions: ["page"],
    rowLimit: 25,
    startRow: 0,
  });
  return rows
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5);
}

// ── Lifetime article count (source: WordPress REST API) ─────────────────

/**
 * Read total post count from a site's WordPress REST API. The X-WP-Total
 * header carries the count for the whole posts collection; per_page=1 plus
 * _fields=id keeps the body trivial. Returns null on any failure (network,
 * non-200, missing header) — caller renders "?" so a single-site outage
 * doesn't break the whole report.
 */
async function fetchPublishedCount(domain: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://${domain}/wp-json/wp/v2/posts?per_page=1&_fields=id`,
      { method: "GET" },
    );
    if (!r.ok) {
      console.error(
        `[search-console] WP count failed for ${domain}: status=${r.status}`,
      );
      return null;
    }
    const total = r.headers.get("x-wp-total");
    const n = total ? parseInt(total, 10) : NaN;
    if (!Number.isFinite(n)) {
      console.error(
        `[search-console] WP count missing X-WP-Total for ${domain}`,
      );
      return null;
    }
    return n;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[search-console] WP count threw for ${domain}: ${msg}`);
    return null;
  }
}

// ── Formatting ───────────────────────────────────────────────────────────

function shortenPagePath(rawUrl: string, domain: string): string {
  // GSC returns full URLs for the page dimension; trim the host so the
  // Telegram message renders cleanly. Fall back to the raw URL if anything
  // weird in the URL parsing.
  try {
    const u = new URL(rawUrl);
    const path = u.pathname || "/";
    return path.length > 60 ? path.slice(0, 57) + "…" : path;
  } catch {
    return rawUrl.replace(`https://${domain}`, "") || rawUrl;
  }
}

function formatReport(
  sites: SiteResult[],
  startDate: string,
  endDate: string,
): string {
  const lines = [
    `📊 *Lifetime SEO* — ${startDate} to ${endDate}`,
    "",
  ];

  for (const site of sites) {
    const publishedStr =
      site.publishedLifetime == null ? "?" : String(site.publishedLifetime);
    lines.push(`*${site.name}* (${site.domain})`);
    lines.push(`Published lifetime: ${publishedStr}`);
    lines.push(
      `Clicks: ${site.totals.clicks} | Impressions: ${site.totals.impressions}`,
    );

    if (site.topKeywords.length > 0) {
      lines.push("Top keywords:");
      for (const kw of site.topKeywords) {
        const k = kw.keys[0] || "(empty)";
        lines.push(
          `  • ${k} — ${kw.impressions} imp / ${kw.clicks} clk / pos ${kw.position.toFixed(1)}`,
        );
      }
    } else {
      lines.push("Top keywords: (no data yet — site may still be indexing)");
    }

    if (site.topPages.length > 0) {
      lines.push("Top pages:");
      for (const pg of site.topPages) {
        const path = shortenPagePath(pg.keys[0] || "", site.domain);
        lines.push(`  • ${path} — ${pg.impressions} imp / ${pg.clicks} clk`);
      }
    } else {
      lines.push("Top pages: (no data yet)");
    }
    lines.push("");
  }

  return lines.join("\n");
}

function isoDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export async function runSearchConsoleReport(): Promise<string> {
  const env = loadEnv();
  const keyJson = env.GOOGLE_SEARCH_CONSOLE_KEY_JSON;
  if (!keyJson) throw new Error("GOOGLE_SEARCH_CONSOLE_KEY_JSON not set");

  const key = JSON.parse(keyJson);
  const token = await getAccessToken(key);

  // Lifetime window: today minus 16 months → today. GSC retains 16 months
  // of data; if a property was verified more recently, GSC silently zeros
  // any pre-verification period — no harm in asking.
  const end = new Date();
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 16);
  const endDate = isoDate(end);
  const startDate = isoDate(start);

  const siteConfigs: { name: string; siteUrl: string; domain: string }[] = [
    { name: "SaaS Sleuth", siteUrl: "sc-domain:saassleuth.com", domain: "saassleuth.com" },
    { name: "BizRunBook", siteUrl: "sc-domain:bizrunbook.com", domain: "bizrunbook.com" },
    { name: "AutoFlow Guide", siteUrl: "sc-domain:autoflowguide.com", domain: "autoflowguide.com" },
  ];

  const results: SiteResult[] = await Promise.all(
    siteConfigs.map(async (s) => {
      // Four parallel calls per site: lifetime totals, top queries, top
      // pages, plus the WP REST API count. All independent; GSC + WP both
      // handle the concurrency fine.
      const [totals, topKeywords, topPages, publishedLifetime] = await Promise.all([
        fetchSiteTotals(token, s.siteUrl, startDate, endDate),
        fetchTopKeywords(token, s.siteUrl, startDate, endDate),
        fetchTopPages(token, s.siteUrl, startDate, endDate),
        fetchPublishedCount(s.domain),
      ]);
      return {
        name: s.name,
        siteUrl: s.siteUrl,
        domain: s.domain,
        publishedLifetime,
        totals,
        topKeywords,
        topPages,
      };
    }),
  );

  return formatReport(results, startDate, endDate);
}

async function submitSitemaps(): Promise<void> {
  const env = loadEnv();
  const key = JSON.parse(env.GOOGLE_SEARCH_CONSOLE_KEY_JSON);
  const token = await getAccessToken(key, "https://www.googleapis.com/auth/webmasters");

  const sitemaps = [
    ["sc-domain:saassleuth.com", "https://saassleuth.com/sitemap_index.xml"],
    ["sc-domain:bizrunbook.com", "https://bizrunbook.com/sitemap_index.xml"],
    ["sc-domain:autoflowguide.com", "https://autoflowguide.com/sitemap_index.xml"],
  ];

  for (const [siteUrl, sitemapUrl] of sitemaps) {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.status !== 204) {
      const body = await res.text();
      console.warn(`Sitemap submit failed for ${sitemapUrl}: ${body}`);
    }
  }
}

// Run directly
if (import.meta.main) {
  await submitSitemaps();
  const report = await runSearchConsoleReport();
  console.log(report);
  await sendTelegram(report, { parseMode: "Markdown" });
}
