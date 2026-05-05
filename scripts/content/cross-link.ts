/**
 * cross-link.ts — Adds "Related Reading" cross-link blocks linking each
 * published article to one article from each of the other two niche
 * sites. Two modes:
 *
 *   1. Standalone batch — `bun scripts/content/cross-link.ts` walks the
 *      whole published corpus and back-fills any article missing the
 *      cross-link marker. Idempotent: previously-linked articles are
 *      skipped via a "<!-- nexus-cross-links -->" marker in the post
 *      content.
 *
 *   2. Per-publish post-step — `addCrossLinksToArticle()` is exported
 *      for pipeline.ts to call after each successful WordPress publish.
 *      Best-effort from the caller's perspective: caller wraps in
 *      try/catch so a cross-link failure on one article never blocks
 *      the rest of the publish loop (matches the per-site isolation
 *      pattern from commit bb4eb4d).
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { getSiteConfig } from "./config.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface Article {
  id: string;
  siteId: "ai-tools" | "productivity" | "saas";
  title: string;
  externalId: string;
  publishedUrl: string;
  status: string;
}

interface RuntimeSiteConfig {
  wpUrl: string;
  username: string;
  appPassword: string;
  displayName: string;
}

// ── Site config ────────────────────────────────────────────────────────────

const SITES: Record<Article["siteId"], { displayName: string }> = {
  "ai-tools": {
    displayName: "BizRunBook",
  },
  productivity: {
    displayName: "AutoFlowGuide",
  },
  saas: {
    displayName: "SaaSSleuth",
  },
};

// ── Stopwords ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "for", "in", "to", "of", "with", "vs", "at", "by", "on",
  "is", "your", "our", "how", "best", "top", "what", "why", "free", "new",
  "2026", "2025", "guide", "review", "business", "small", "team", "teams",
  "tools", "tool", "software",
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function extractKeywords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((w) => b.has(w)));
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

function basicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

async function getRuntimeSiteConfig(siteId: Article["siteId"]): Promise<RuntimeSiteConfig> {
  const site = await getSiteConfig(siteId);
  return {
    wpUrl: site.wordpress.url.replace(/\/$/, ""),
    username: site.wordpress.username,
    appPassword: site.wordpress.appPassword,
    displayName: SITES[siteId].displayName,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCrossLinkBlock(
  link1: { url: string; title: string; siteName: string },
  link2: { url: string; title: string; siteName: string }
): string {
  return `<!-- nexus-cross-links -->
<div style="background:#f0f4ff;border-left:4px solid #3b5bdb;padding:16px 20px;margin:32px 0;border-radius:0 6px 6px 0">
<p style="margin:0 0 10px 0;font-weight:700;font-size:0.95em;color:#1e3a8a">Related Reading</p>
<ul style="margin:0;padding-left:20px;line-height:1.8">
<li><a href="${link1.url}">${link1.title}</a> via ${link1.siteName}</li>
<li><a href="${link2.url}">${link2.title}</a> via ${link2.siteName}</li>
</ul>
</div>`;
}

// ── Load articles ──────────────────────────────────────────────────────────

async function loadArticles(): Promise<Article[]> {
  const dir = join(process.cwd(), "data/content/published");
  const files = await readdir(dir);
  const articles: Article[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const raw = await readFile(join(dir, file), "utf-8");
    const data = JSON.parse(raw);

    if (
      data.status === "published" &&
      data.externalId &&
      data.publishedUrl &&
      SITES[data.siteId]
    ) {
      articles.push({
        id: data.id,
        siteId: data.siteId,
        title: data.title,
        externalId: data.externalId,
        publishedUrl: data.publishedUrl,
        status: data.status,
      });
    }
  }

  return articles;
}

// ── Find best cross-link from another site ─────────────────────────────────

function findBestMatch(
  source: Article,
  candidates: Article[]
): Article {
  const sourceKw = extractKeywords(source.title);
  let bestScore = -1;
  let bestArticle = candidates[0];

  for (const candidate of candidates) {
    const candidateKw = extractKeywords(candidate.title);
    const score = jaccard(sourceKw, candidateKw);
    if (score > bestScore) {
      bestScore = score;
      bestArticle = candidate;
    }
  }

  // If Jaccard = 0 for all, fallback is candidates[0] (already set as bestArticle initially)
  return bestArticle;
}

// ── WP API calls ───────────────────────────────────────────────────────────

async function fetchWpContent(
  article: Article
): Promise<{ raw: string; rendered: string }> {
  const site = await getRuntimeSiteConfig(article.siteId);
  const url = `${site.wpUrl}/wp-json/wp/v2/posts/${article.externalId}?_fields=id,content`;

  const res = await fetch(url, {
    headers: {
      Authorization: basicAuth(site.username, site.appPassword),
    },
  });

  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { content?: { raw?: string; rendered?: string } };
  return {
    raw: data.content?.raw ?? "",
    rendered: data.content?.rendered ?? "",
  };
}

async function updateWpContent(
  article: Article,
  updatedContent: string
): Promise<void> {
  const site = await getRuntimeSiteConfig(article.siteId);
  const url = `${site.wpUrl}/wp-json/wp/v2/posts/${article.externalId}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(site.username, site.appPassword),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: updatedContent }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST ${url} → ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
}

// ── Per-article entrypoint (called by pipeline.ts post-publish) ───────────

/**
 * Add a cross-link block to a single just-published article. Loads the
 * full published corpus on each call so newly-published siblings in the
 * same pipeline run are immediately eligible as match candidates.
 *
 * Returns:
 *   { linked: true }                              on success
 *   { linked: false, reason: "<short>" }          on no-op (already linked,
 *                                                  unsupported site, missing
 *                                                  external_id, etc.)
 *
 * Throws on hard upstream errors (WP fetch / WP update). The caller must
 * wrap in try/catch — see pipeline.ts cmdPublish.
 */
export async function addCrossLinksToArticle(input: {
  id: string;
  siteId: string;
  title: string;
  externalId?: string | null;
  publishedUrl?: string | null;
}): Promise<{ linked: boolean; reason?: string; matched?: { siteId: string; title: string }[] }> {
  if (!SITES[input.siteId]) {
    return { linked: false, reason: `unsupported siteId: ${input.siteId}` };
  }
  if (!input.externalId || !input.publishedUrl) {
    return { linked: false, reason: "article missing externalId or publishedUrl" };
  }

  const article: Article = {
    id: input.id,
    siteId: input.siteId as Article["siteId"],
    title: input.title,
    externalId: input.externalId,
    publishedUrl: input.publishedUrl,
    status: "published",
  };

  // Re-load the corpus on every call so freshly-published siblings from
  // the same pipeline run are visible (cmdPublish iterates serially; an
  // earlier article published this turn is on disk by the time we get
  // here for a later one).
  const corpus = await loadArticles();
  const otherSiteIds = (Object.keys(SITES) as Array<Article["siteId"]>).filter(
    (s) => s !== article.siteId,
  );

  const matches: Article[] = [];
  for (const otherId of otherSiteIds) {
    const candidates = corpus.filter((a) => a.siteId === otherId && a.id !== article.id);
    if (candidates.length === 0) continue;
    matches.push(findBestMatch(article, candidates));
  }
  if (matches.length < 2) {
    return { linked: false, reason: `insufficient corpus (${matches.length}/2 cross-site matches)` };
  }

  const { raw, rendered } = await fetchWpContent(article);
  const workingContent = raw || rendered;

  if (workingContent.includes("nexus-cross-links")) {
    return { linked: false, reason: "already linked" };
  }

  const block = buildCrossLinkBlock(
    {
      url: matches[0].publishedUrl,
      title: matches[0].title,
      siteName: SITES[matches[0].siteId].displayName,
    },
    {
      url: matches[1].publishedUrl,
      title: matches[1].title,
      siteName: SITES[matches[1].siteId].displayName,
    },
  );

  await updateWpContent(article, workingContent + "\n" + block);

  return {
    linked: true,
    matched: matches.map((m) => ({ siteId: m.siteId, title: m.title })),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Nexus Cross-Link Script ===\n");

  // 1. Load articles
  const allArticles = await loadArticles();
  console.log(`Loaded ${allArticles.length} published articles\n`);

  // Group by site
  const bySite: Record<string, Article[]> = {
    "ai-tools": [],
    productivity: [],
    saas: [],
  };
  for (const a of allArticles) {
    bySite[a.siteId].push(a);
  }

  console.log(
    `  ai-tools (bizrunbook.com): ${bySite["ai-tools"].length} articles`
  );
  console.log(
    `  productivity (autoflowguide.com): ${bySite["productivity"].length} articles`
  );
  console.log(`  saas (saassleuth.com): ${bySite["saas"].length} articles\n`);

  // 2. Process each article
  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  for (const article of allArticles) {
    totalProcessed++;

    // Find best match from each of the OTHER two sites
    const otherSites = Object.keys(bySite).filter((s) => s !== article.siteId);
    const match1 = findBestMatch(article, bySite[otherSites[0]]);
    const match2 = findBestMatch(article, bySite[otherSites[1]]);

    // Add 500ms delay between API calls (rate limiting)
    if (totalProcessed > 1) {
      await sleep(500);
    }

    try {
      // 3. Fetch live WP content
      const { raw, rendered } = await fetchWpContent(article);
      const workingContent = raw || rendered;

      // 4. Idempotency check
      if (workingContent.includes("nexus-cross-links")) {
        console.log(`SKIP  [${article.siteId}] ${article.title}`);
        totalSkipped++;
        continue;
      }

      // 5. Build cross-link block
      const site1 = SITES[match1.siteId];
      const site2 = SITES[match2.siteId];

      const block = buildCrossLinkBlock(
        {
          url: match1.publishedUrl,
          title: match1.title,
          siteName: site1.displayName,
        },
        {
          url: match2.publishedUrl,
          title: match2.title,
          siteName: site2.displayName,
        }
      );

      const updatedContent = workingContent + "\n" + block;

      // 6. Update via WP REST API
      await sleep(500); // extra delay between GET and POST
      await updateWpContent(article, updatedContent);

      console.log(
        `LINKED [${article.siteId}] | ${article.title}\n` +
          `         → "${match1.title}" (${site1.displayName})\n` +
          `         + "${match2.title}" (${site2.displayName})`
      );
      totalUpdated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ERROR  [${article.siteId}] ${article.title}: ${msg}`);
      errors.push(`[${article.siteId}] ${article.title}: ${msg}`);
    }
  }

  // 8. Summary
  console.log("\n=== Summary ===");
  console.log(`Total processed : ${totalProcessed}`);
  console.log(`Total updated   : ${totalUpdated}`);
  console.log(`Total skipped   : ${totalSkipped} (already linked)`);
  console.log(`Errors          : ${errors.length}`);

  if (errors.length > 0) {
    console.log("\nError details:");
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
  }
}

// Run main() only when invoked directly. Importing this module from
// pipeline.ts (for the per-publish post-step) must NOT kick off the
// batch back-fill.
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
