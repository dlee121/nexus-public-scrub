/**
 * Image fetching via Unsplash API.
 * Requires UNSPLASH_ACCESS_KEY in data/content/.env
 * Free tier: 50 requests/hour — plenty for daily publishing.
 *
 * Unsplash guidelines require attribution. We store credit info
 * and attach it as the WP image caption automatically.
 */

import { DATA_DIR } from "./config.ts";
import { join } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

export interface UnsplashPhoto {
  url: string;
  altText: string;
  credit: string;       // "Photo by Name on Unsplash"
  creditUrl: string;    // photographer profile URL with UTM
}

async function getUnsplashKey(): Promise<string | null> {
  // Check env first (already loaded by config.ts in most code paths)
  if (process.env.UNSPLASH_ACCESS_KEY) return process.env.UNSPLASH_ACCESS_KEY;

  // Try loading from .env directly
  const envPath = join(DATA_DIR, ".env");
  if (existsSync(envPath)) {
    const raw = await readFile(envPath, "utf-8");
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key === "UNSPLASH_ACCESS_KEY") {
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (val) return val;
      }
    }
  }
  return null;
}

/**
 * Search Unsplash for a landscape photo matching the keyword.
 * Returns null if no key configured or no results found.
 */
export async function searchUnsplash(keyword: string): Promise<UnsplashPhoto | null> {
  const key = await getUnsplashKey();
  if (!key) return null;

  try {
    const query = encodeURIComponent(keyword);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${query}&per_page=3&orientation=landscape&content_filter=high`,
      { headers: { Authorization: `Client-ID ${key}` } }
    );
    if (!res.ok) return null;

    const data = await res.json() as {
      results: Array<{
        urls: { regular: string };
        alt_description: string | null;
        description: string | null;
        user: { name: string; links: { html: string } };
      }>;
    };

    if (!data.results?.length) return null;

    const photo = data.results[0];
    const photographerUrl = `${photo.user.links.html}?utm_source=nexus_content&utm_medium=referral`;

    return {
      url: photo.urls.regular,
      altText: photo.alt_description || photo.description || keyword,
      credit: `Photo by ${photo.user.name} on Unsplash`,
      creditUrl: photographerUrl,
    };
  } catch {
    return null;
  }
}
