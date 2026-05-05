/**
 * Affiliate link injection.
 * Scans article HTML for tool names from affiliate-tools.json and wraps
 * the first occurrence (in text, not already inside an <a> tag) with
 * the affiliate URL. Skips PLACEHOLDER URLs.
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface AffiliateTool {
  id: string;
  name: string;
  url: string;
  affiliateUrl: string;
  sites: string[];
}

interface AffiliateData {
  tools: AffiliateTool[];
}

let _tools: AffiliateTool[] | null = null;

async function loadTools(): Promise<AffiliateTool[]> {
  if (_tools) return _tools;
  try {
    const raw = await readFile(join(ROOT, "data/content/affiliate-tools.json"), "utf-8");
    const data = JSON.parse(raw) as AffiliateData;
    _tools = data.tools;
    return _tools;
  } catch {
    return [];
  }
}

/**
 * Inject affiliate links into HTML content for a given site.
 * Uses affiliate URL if available, falls back to direct URL for editorial linking.
 * Affiliate links get rel="nofollow sponsored"; editorial links get rel="nofollow".
 */
export async function injectAffiliateLinks(html: string, siteId: string): Promise<string> {
  const tools = await loadTools();

  // Tools relevant to this site that have at least a direct URL
  const active = tools.filter(
    (t) =>
      (t.sites.includes(siteId) || t.sites.length === 0) &&
      t.url
  );

  if (active.length === 0) return html;

  let result = html;

  for (const tool of active) {
    const isAffiliate = tool.affiliateUrl && !tool.affiliateUrl.startsWith("PLACEHOLDER");
    const href = isAffiliate ? tool.affiliateUrl : tool.url;
    const rel = isAffiliate ? "nofollow sponsored" : "nofollow";
    const linkTag = `<a href="${href}" rel="${rel}" target="_blank">${tool.name}</a>`;
    result = replaceFirstOutsideLinks(result, tool.name, linkTag);
  }

  return result;
}

/**
 * Replace the first occurrence of `search` with `replacement`,
 * but only in text content outside of existing <a> tags.
 */
function replaceFirstOutsideLinks(html: string, search: string, replacement: string): string {
  // Split HTML into segments: inside <a>...</a> and outside
  const parts: Array<{ text: string; isLink: boolean }> = [];
  const linkRe = /<a[\s\S]*?<\/a>/gi;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRe.exec(html)) !== null) {
    if (match.index > last) {
      parts.push({ text: html.slice(last, match.index), isLink: false });
    }
    parts.push({ text: match[0], isLink: true });
    last = match.index + match[0].length;
  }
  if (last < html.length) {
    parts.push({ text: html.slice(last), isLink: false });
  }

  // Do one replacement across non-link segments
  let replaced = false;
  return parts
    .map((part) => {
      if (replaced || part.isLink) return part.text;
      // Case-insensitive exact word match
      const re = new RegExp(`(?<![\\w-])${escapeRegex(search)}(?![\\w-])`, "i");
      const m = re.exec(part.text);
      if (!m) return part.text;
      replaced = true;
      return part.text.slice(0, m.index) + replacement + part.text.slice(m.index + m[0].length);
    })
    .join("");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
