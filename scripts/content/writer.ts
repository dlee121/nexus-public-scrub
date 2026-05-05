/**
 * SEO article writer.
 * Dispatches to the Writer Nexus entity — no direct API key required.
 */

import { randomUUID } from "crypto";
import { getSiteConfig } from "./config.ts";
import { dispatchToWriter } from "./writer-dispatch.ts";
import { injectAffiliateLinks } from "./affiliate.ts";
import type { Article, ArticleTopic } from "./types.ts";

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
}

function countWords(html: string): number {
  return html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
}

function selectCategory(categories: string[], topic: ArticleTopic): string {
  const kw = topic.keyword.toLowerCase();
  const title = topic.title.toLowerCase();
  if (title.includes("best") || title.includes("top") || kw.includes("best"))
    return categories.find((c) => c.toLowerCase().includes("best") || c === "Reviews") ?? categories[0];
  if (title.includes("vs") || title.includes("compare") || title.includes("alternatives"))
    return categories.find((c) => c.toLowerCase().includes("comp") || c === "Comparisons") ?? categories[0];
  if (title.includes("how to") || title.includes("guide") || kw.includes("tutorial"))
    return categories.find((c) => c === "How-To" || c === "Tutorials") ?? categories[0];
  return categories[0];
}

function generateTags(topic: ArticleTopic): string[] {
  return topic.keyword
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 4)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
}

export async function writeSeoArticle(
  siteId: string,
  topic: ArticleTopic,
  relatedArticles: { title: string; url: string }[] = []
): Promise<Article> {
  const site = await getSiteConfig(siteId);

  const internalLinkNote =
    relatedArticles.length > 0
      ? `\nINTERNAL LINKS — naturally link to 2-3 of these existing articles where relevant (use their exact URLs):\n${relatedArticles.map((a) => `  - ${a.title}: ${a.url}`).join("\n")}\n`
      : topic.internalLinks && topic.internalLinks.length > 0
      ? `Include internal links for these related topics: ${topic.internalLinks.join(", ")}.`
      : "";

  const prompt = `Write a complete, visually rich SEO article for "${site.name}" (${site.domain}).

Keyword: "${topic.keyword}"
Title: ${topic.title}
Angle: ${topic.angle}
Target length: ${topic.estimatedWordCount} words (aim for at least 1800)
Niche: ${site.niche}
Audience: ${site.targetAudience}
Affiliate programs to naturally mention: ${site.affiliatePrograms.join(", ")}
${internalLinkNote}

Respond using EXACTLY this format (do not deviate):

TITLE: [final H1 title]
SLUG: [url-slug]
EXCERPT: [meta description 150-160 chars]
===CONTENT===
[full article body — requirements below]

CONTENT REQUIREMENTS:
1. Open with a "Quick Answer" box using this exact HTML (fill in 2-3 sentence summary):
<div style="background:#f0f7ff;border-left:4px solid #2563eb;padding:16px 20px;margin:0 0 24px 0;border-radius:4px;"><strong>Quick Answer:</strong> [2-3 sentence direct answer to the keyword question]</div>

2. Engaging intro paragraph (no heading), then structured H2/H3 sections

3. Include at least ONE comparison table using this format:
<table style="width:100%;border-collapse:collapse;margin:24px 0;"><thead><tr style="background:#f8fafc;"><th style="padding:10px 14px;text-align:left;border:1px solid #e2e8f0;">[Col]</th>...</tr></thead><tbody><tr><td style="padding:10px 14px;border:1px solid #e2e8f0;">[Val]</td>...</tr></tbody></table>

4. Include at least TWO callout boxes. Use tip boxes for advice:
<div style="background:#f0fdf4;border-left:4px solid #22c55e;padding:14px 18px;margin:20px 0;border-radius:4px;"><strong>💡 Pro Tip:</strong> [tip text]</div>
And warning boxes where relevant:
<div style="background:#fff7ed;border-left:4px solid #f97316;padding:14px 18px;margin:20px 0;border-radius:4px;"><strong>⚠️ Watch Out:</strong> [warning text]</div>

5. "Key Takeaways" section before the conclusion:
<div style="background:#fafafa;border:1px solid #e2e8f0;padding:20px 24px;margin:24px 0;border-radius:8px;"><strong>Key Takeaways</strong><ul style="margin:10px 0 0 0;padding-left:20px;">[3-5 bullet summary points]</ul></div>

6. End with an FAQ section (H2: "Frequently Asked Questions") with 3-5 Q&As using H3 for questions

7. Use ul/ol lists, bold key terms, H2/H3 headings throughout. Write second-person, conversational but authoritative. Naturally weave in affiliate tool mentions where they genuinely fit. No outer html/body tags, no H1.`;

  const raw = await dispatchToWriter(prompt);

  // Parse delimiter-based response from Writer
  const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
  const slugMatch = raw.match(/^SLUG:\s*(.+)/m);
  const excerptMatch = raw.match(/^EXCERPT:\s*(.+)/m);
  const contentMatch = raw.match(/===CONTENT===\s*([\s\S]+)/);

  const parsed = {
    title: titleMatch?.[1]?.trim() ?? topic.title,
    slug: slugMatch?.[1]?.trim() ?? slugify(topic.title),
    excerpt: excerptMatch?.[1]?.trim() ?? `${topic.title} — ${topic.angle.slice(0, 100)}`,
    content: contentMatch?.[1]?.trim() ?? raw,
  };

  // Inject affiliate links for tools mentioned in the article
  const linkedContent = await injectAffiliateLinks(parsed.content || raw, siteId);

  return {
    id: randomUUID(),
    siteId,
    channel: "wordpress",
    topic,
    title: parsed.title || topic.title,
    metaDescription: parsed.excerpt || `${topic.title} — ${topic.angle.slice(0, 100)}`,
    slug: parsed.slug || slugify(topic.title),
    content: linkedContent,
    categories: [selectCategory(site.categories, topic)],
    tags: generateTags(topic),
    wordCount: countWords(parsed.content || raw),
    status: "ready",
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    publishedAt: null,
    publishedUrl: null,
    externalId: null,
    error: null,
  };
}

export async function writeMediumArticle(topic: ArticleTopic): Promise<Article> {
  const prompt = `Write a thought-leadership article for Medium.

Topic: "${topic.keyword}"
Title: ${topic.title}
Angle: ${topic.angle}
Target length: ${topic.estimatedWordCount} words

The author is building Nexus, an AI orchestration system with autonomous entities, and is an entrepreneur focused on AI-powered business systems. Write in first-person, personal voice. Open with a strong hook. Build a clear argument. Use concrete examples. No excessive bullet points — this is long-form narrative.

Respond using EXACTLY this format:

TITLE: [final title]
SLUG: [url-slug]
EXCERPT: [meta description]
===CONTENT===
[article body as clean HTML — no outer tags]`;

  const raw = await dispatchToWriter(prompt);

  const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
  const slugMatch = raw.match(/^SLUG:\s*(.+)/m);
  const excerptMatch = raw.match(/^EXCERPT:\s*(.+)/m);
  const contentMatch = raw.match(/===CONTENT===\s*([\s\S]+)/);

  const parsed = {
    title: titleMatch?.[1]?.trim() ?? topic.title,
    slug: slugMatch?.[1]?.trim() ?? slugify(topic.title),
    excerpt: excerptMatch?.[1]?.trim() ?? topic.title,
    content: contentMatch?.[1]?.trim() ?? raw,
  };

  return {
    id: randomUUID(),
    siteId: "medium",
    channel: "medium",
    topic,
    title: parsed.title || topic.title,
    metaDescription: parsed.excerpt || topic.title,
    slug: parsed.slug || slugify(topic.title),
    content: parsed.content || raw,
    categories: [],
    tags: ["AI", "Automation", "Entrepreneurship"],
    wordCount: countWords(parsed.content || raw),
    status: "ready",
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    publishedAt: null,
    publishedUrl: null,
    externalId: null,
    error: null,
  };
}
