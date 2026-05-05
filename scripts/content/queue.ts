import { mkdir, readdir, readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { QUEUE_DIR, PUBLISHED_DIR } from "./config.ts";
import type { Article, ArticleStatus } from "./types.ts";

async function ensureDirs() {
  await mkdir(QUEUE_DIR, { recursive: true });
  await mkdir(PUBLISHED_DIR, { recursive: true });
}

export async function saveArticle(article: Article): Promise<void> {
  await ensureDirs();
  const path = join(QUEUE_DIR, `${article.id}.json`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(article, null, 2));
  await rename(tmp, path);
}

export async function getArticle(id: string): Promise<Article | null> {
  const queuePath = join(QUEUE_DIR, `${id}.json`);
  const publishedPath = join(PUBLISHED_DIR, `${id}.json`);
  const path = existsSync(queuePath) ? queuePath : existsSync(publishedPath) ? publishedPath : null;
  if (!path) return null;
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as Article;
}

export async function updateArticle(article: Article): Promise<void> {
  if (article.status === "published") {
    // Move to published archive
    const src = join(QUEUE_DIR, `${article.id}.json`);
    const dest = join(PUBLISHED_DIR, `${article.id}.json`);
    await writeFile(dest, JSON.stringify(article, null, 2));
    if (existsSync(src)) {
      const { unlink } = await import("fs/promises");
      await unlink(src);
    }
  } else {
    await saveArticle(article);
  }
}

export async function listQueue(
  filter?: { status?: ArticleStatus; siteId?: string }
): Promise<Article[]> {
  await ensureDirs();
  if (!existsSync(QUEUE_DIR)) return [];
  const files = await readdir(QUEUE_DIR);
  const articles: Article[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(QUEUE_DIR, f), "utf-8");
      const a = JSON.parse(raw) as Article;
      if (filter?.status && a.status !== filter.status) continue;
      if (filter?.siteId && a.siteId !== filter.siteId) continue;
      articles.push(a);
    } catch {}
  }
  return articles.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listPublished(siteId?: string): Promise<Article[]> {
  await ensureDirs();
  if (!existsSync(PUBLISHED_DIR)) return [];
  const files = await readdir(PUBLISHED_DIR);
  const articles: Article[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(PUBLISHED_DIR, f), "utf-8");
      const a = JSON.parse(raw) as Article;
      if (siteId && a.siteId !== siteId) continue;
      articles.push(a);
    } catch {}
  }
  return articles;
}

export async function queueStats(): Promise<Record<ArticleStatus, number>> {
  const articles = await listQueue();
  const stats: Record<ArticleStatus, number> = {
    pending: 0,
    ready: 0,
    published: 0,
    failed: 0,
  };
  for (const a of articles) {
    stats[a.status] = (stats[a.status] || 0) + 1;
  }
  return stats;
}
