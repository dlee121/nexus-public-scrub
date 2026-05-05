#!/usr/bin/env bun
/**
 * Content Publishing Pipeline
 *
 * Commands:
 *   bun scripts/content/pipeline.ts topics [siteId] [--count=10]
 *   bun scripts/content/pipeline.ts write [siteId] [--topic="keyword"] [--count=1]
 *   bun scripts/content/pipeline.ts publish [--site=siteId] [--draft]
 *   bun scripts/content/pipeline.ts daily          -- run full daily cycle
 *   bun scripts/content/pipeline.ts status         -- show queue stats
 *   bun scripts/content/pipeline.ts medium [--write] [--publish]
 */

import { generateTopics, generateMediumTopics } from "./topics.ts";
import { writeSeoArticle, writeMediumArticle } from "./writer.ts";
import { publishToWordPress, updateWordPressPost } from "./wordpress.ts";
import { publishToMedium } from "./medium.ts";
import { saveArticle, updateArticle, listQueue, queueStats, getArticle, listPublished } from "./queue.ts";
import { getAllSiteIds, getSiteConfig } from "./config.ts";
import { sendTelegram } from "./telegram.ts";
import { addCrossLinksToArticle } from "./cross-link.ts";
import type { Article, ArticleTopic } from "./types.ts";

/**
 * Per-article publish notification. Captures URL + title + site + slug +
 * word count + intent so the operator sees what just shipped without
 * having to dig into the queue. Best-effort — never blocks publish.
 */
async function notifyPublished(article: Article, url: string, draft: boolean): Promise<void> {
  const heading = draft ? "📝 Drafted" : "✅ Published";
  const channel = article.channel === "medium" ? "Medium" : article.siteId;
  const intent = article.topic?.intent ? ` · ${article.topic.intent}` : "";
  const lines = [
    `${heading} — ${article.title}`,
    url,
    "",
    `Site: ${channel}${intent}`,
    `Slug: ${article.slug || "?"}`,
    `Words: ${article.wordCount}`,
  ];
  if (article.categories && article.categories.length > 0) {
    lines.push(`Categories: ${article.categories.join(", ")}`);
  }
  await sendTelegram(lines.join("\n"));
}

/**
 * Best-effort cross-link injection on a freshly-published article. Picks
 * one related article from each of the OTHER two niche sites by Jaccard
 * keyword similarity and appends a "Related Reading" block via the WP
 * REST API. Idempotent (skips if the marker is already present).
 *
 * Failure must not abort the publish loop — matches the per-site
 * isolation pattern from commit bb4eb4d. Caller drops a log line on
 * failure and continues.
 */
async function addCrossLinks(article: Article): Promise<void> {
  // Only WordPress articles get cross-links; Medium has its own surface.
  if (article.channel !== "wordpress") return;
  try {
    const result = await addCrossLinksToArticle({
      id: article.id,
      siteId: article.siteId,
      title: article.title,
      externalId: article.externalId,
      publishedUrl: article.publishedUrl,
    });
    if (result.linked) {
      const matchedNote = result.matched
        ?.map((m) => `${m.siteId}:"${m.title.slice(0, 40)}"`)
        .join(", ") ?? "";
      log(`Cross-linked ${article.id} → ${matchedNote}`);
    } else {
      log(`Cross-link skipped for ${article.id}: ${result.reason ?? "unknown"}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Cross-link failed for ${article.id} (non-fatal): ${msg}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function parseArgs(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags[k] = v ?? "true";
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdTopics(siteId: string, count: number) {
  log(`Generating ${count} topics for site: ${siteId}`);
  const topics = await generateTopics(siteId, count);
  console.log(JSON.stringify(topics, null, 2));
  log(`Generated ${topics.length} topics`);
}

async function cmdWrite(siteId: string, count: number, topicOverride?: string) {
  log(`Writing ${count} article(s) for site: ${siteId}`);

  const published = await listPublished(siteId);
  let topics: ArticleTopic[];
  if (topicOverride) {
    topics = [{
      keyword: topicOverride,
      title: topicOverride,
      intent: "informational",
      angle: "Comprehensive guide",
      estimatedWordCount: 1500,
    }];
  } else {
    log("Generating topics first...");
    const existingKeywords = published.map(a => a.topic?.keyword).filter(Boolean) as string[];
    if (existingKeywords.length > 0) {
      log(`Passing ${existingKeywords.length} existing keywords to avoid duplicates`);
    }
    topics = await generateTopics(siteId, count, existingKeywords);
  }

  const relatedArticles = published
    .filter((a) => a.publishedUrl)
    .map((a) => ({ title: a.title, url: a.publishedUrl! }))
    .slice(0, 20);

  for (const topic of topics.slice(0, count)) {
    log(`Writing: "${topic.title}"`);
    try {
      const article = await writeSeoArticle(siteId, topic, relatedArticles);
      await saveArticle(article);
      log(`Saved article ${article.id} (${article.wordCount} words)`);
    } catch (e) {
      log(`ERROR writing article: ${e}`);
    }
  }
}

async function cmdPublish(siteId: string | undefined, draft: boolean) {
  const filter = siteId ? { status: "ready" as const, siteId } : { status: "ready" as const };
  const queue = await listQueue(filter);
  log(`Found ${queue.length} ready articles to publish`);

  for (const article of queue) {
    if (article.channel === "medium") continue; // handle separately
    log(`Publishing: "${article.title}" → ${article.siteId}`);
    try {
      const { postId, url } = await publishToWordPress(article, draft ? "draft" : "publish");
      const updated: Article = {
        ...article,
        status: "published",
        publishedAt: new Date().toISOString(),
        publishedUrl: url,
        externalId: String(postId),
      };
      await updateArticle(updated);
      log(`Published: ${url}`);
      await notifyPublished(updated, url, draft).catch((e) =>
        log(`Telegram notify failed (non-fatal): ${e}`)
      );
      // Cross-linking runs after notification so a slow WP-update on the
      // cross-link step doesn't delay the Telegram ping. The function
      // catches its own errors — failure here never aborts the loop.
      await addCrossLinks(updated);
    } catch (e) {
      const failed: Article = { ...article, status: "failed", error: String(e) };
      await updateArticle(failed);
      log(`FAILED: ${e}`);
    }
  }
}

async function cmdMedium(write: boolean, publish: boolean) {
  if (write) {
    log("Generating Medium topic...");
    const topics = await generateMediumTopics(1);
    const topic = topics[0];
    log(`Writing Medium article: "${topic.title}"`);
    const article = await writeMediumArticle(topic);
    await saveArticle(article);
    log(`Saved Medium article ${article.id}`);
  }

  if (publish) {
    const queue = await listQueue({ status: "ready", siteId: "medium" });
    if (queue.length === 0) {
      log("No Medium articles ready to publish");
      return;
    }
    const article = queue[0]; // Publish one at a time
    log(`Publishing to Medium: "${article.title}"`);
    try {
      const { postId, url } = await publishToMedium(article, "draft");
      const updated: Article = {
        ...article,
        status: "published",
        publishedAt: new Date().toISOString(),
        publishedUrl: url,
        externalId: postId,
      };
      await updateArticle(updated);
      log(`Published to Medium: ${url}`);
      await notifyPublished(updated, url, true).catch((e) =>
        log(`Telegram notify failed (non-fatal): ${e}`)
      );
    } catch (e) {
      const failed: Article = { ...article, status: "failed", error: String(e) };
      await updateArticle(failed);
      log(`FAILED: ${e}`);
    }
  }
}

async function cmdRewrite(articleId: string) {
  const article = await getArticle(articleId);
  if (!article) {
    log(`ERROR: Article ${articleId} not found`);
    return;
  }
  if (!article.externalId) {
    log(`ERROR: Article ${articleId} has no WP post ID — publish it first`);
    return;
  }
  log(`Rewriting: "${article.title}" (WP post ${article.externalId})`);
  try {
    const rewritten = await writeSeoArticle(article.siteId, article.topic);
    const postId = parseInt(article.externalId);
    const { url } = await updateWordPressPost(article.siteId, postId, rewritten);
    const updated: Article = {
      ...article,
      title: rewritten.title,
      content: rewritten.content,
      metaDescription: rewritten.metaDescription,
      wordCount: rewritten.wordCount,
      publishedUrl: url,
    };
    await updateArticle(updated);
    log(`Updated: ${url}`);
  } catch (e) {
    log(`ERROR rewriting ${articleId}: ${e}`);
  }
}

async function cmdBackfillSchema() {
  log("=== BACKFILL SCHEMA START ===");
  const published = await listPublished();
  const wpOnly = published.filter((a) => a.channel === "wordpress" && a.externalId);
  log(`Found ${wpOnly.length} published WordPress articles to backfill`);

  let ok = 0;
  let fail = 0;
  for (const article of wpOnly) {
    try {
      const postId = parseInt(article.externalId!);
      await updateWordPressPost(article.siteId, postId, article);
      log(`✓ ${article.title}`);
      ok++;
    } catch (e) {
      log(`✗ ${article.title}: ${e}`);
      fail++;
    }
  }
  log(`=== BACKFILL COMPLETE: ${ok} ok, ${fail} failed ===`);
}

async function cmdDaily() {
  log("=== DAILY PIPELINE START ===");
  const siteIds = await getAllSiteIds();

  // 1. Write articles per site based on publishSchedule.articlesPerDay.
  //    Per-site failures are isolated: a topic-generation or write error on
  //    one site must not block the publish step for sites that succeeded.
  //    Without this, a single bad LLM response (e.g. Writer returning an
  //    article payload when asked for a topics JSON array) used to abort
  //    the whole daily run, stranding already-written articles in the queue.
  const writeFailures: Array<{ siteId: string; error: string }> = [];
  for (const siteId of siteIds) {
    log(`--- Site: ${siteId} ---`);
    try {
      const site = await getSiteConfig(siteId);
      const count = site.publishSchedule?.articlesPerDay ?? 1;
      await cmdWrite(siteId, count);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ERROR writing site ${siteId}: ${msg}`);
      writeFailures.push({ siteId, error: msg });
    }
  }

  // 2. Publish all ready articles live — runs unconditionally so that
  //    successful per-site writes from step 1 don't get stranded by a
  //    sibling site's failure.
  log("--- Publishing ready articles ---");
  try {
    await cmdPublish(undefined, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`ERROR during publish step: ${msg}`);
    writeFailures.push({ siteId: "publish-step", error: msg });
  }

  if (writeFailures.length > 0) {
    // Emit a structured summary line on stderr so the wrapper script's
    // log-extractor can surface it in the Telegram notification.
    const summary = writeFailures
      .map((f) => `${f.siteId}: ${f.error.replace(/\s+/g, " ").slice(0, 200)}`)
      .join(" | ");
    console.error(`ERROR: daily pipeline finished with ${writeFailures.length} failure(s) — ${summary}`);
    log("=== DAILY PIPELINE COMPLETE (with failures) ===");
    process.exit(1);
  }

  log("=== DAILY PIPELINE COMPLETE ===");
}

async function cmdStatus() {
  const stats = await queueStats();
  const queue = await listQueue();
  console.log("\nQueue Stats:");
  console.log(`  pending:   ${stats.pending}`);
  console.log(`  ready:     ${stats.ready}`);
  console.log(`  published: ${stats.published}`);
  console.log(`  failed:    ${stats.failed}`);

  const bysite: Record<string, number> = {};
  for (const a of queue) {
    bysite[a.siteId] = (bysite[a.siteId] || 0) + 1;
  }
  console.log("\nBy Site:");
  for (const [site, count] of Object.entries(bysite)) {
    console.log(`  ${site}: ${count}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const { flags, positional } = parseArgs(args);
const cmd = positional[0];

switch (cmd) {
  case "topics": {
    const siteId = positional[1] || "ai-tools";
    const count = parseInt(flags.count || "10");
    await cmdTopics(siteId, count);
    break;
  }
  case "write": {
    const siteId = positional[1] || "ai-tools";
    const count = parseInt(flags.count || "1");
    await cmdWrite(siteId, count, flags.topic);
    break;
  }
  case "publish": {
    const siteId = positional[1] || flags.site;
    const draft = flags.draft === "true";
    await cmdPublish(siteId, draft);
    break;
  }
  case "medium": {
    await cmdMedium(flags.write === "true", flags.publish === "true");
    break;
  }
  case "rewrite": {
    const articleId = positional[1];
    if (!articleId) { console.log("Usage: rewrite <articleId>"); break; }
    await cmdRewrite(articleId);
    break;
  }
  case "backfill-schema": {
    await cmdBackfillSchema();
    break;
  }
  case "daily": {
    await cmdDaily();
    break;
  }
  case "status": {
    await cmdStatus();
    break;
  }
  default: {
    console.log(`
Content Publishing Pipeline

Usage:
  bun scripts/content/pipeline.ts <command> [options]

Commands:
  topics [siteId] [--count=10]         Generate topic ideas
  write [siteId] [--count=1]           Write articles and add to queue
                 [--topic="keyword"]   Write for a specific keyword
  publish [siteId] [--draft]           Publish ready articles (--draft for WP draft)
  medium [--write] [--publish]         Handle Medium content
  daily                                Run full daily pipeline
  status                               Show queue stats

Site IDs: ai-tools, productivity, saas
    `);
  }
}
