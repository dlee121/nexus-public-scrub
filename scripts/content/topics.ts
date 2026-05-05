/**
 * Topic and keyword generation for niche sites.
 * Dispatches to the Writer Nexus entity — no direct API key required.
 */

import { getSiteConfig, getMediumConfig } from "./config.ts";
import { dispatchToWriter } from "./writer-dispatch.ts";
import type { ArticleTopic } from "./types.ts";

function parseTopicsJson(raw: string): ArticleTopic[] {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    // Include a head + tail snippet of the bad response so the operator can
    // see what Writer actually returned (e.g. an article-shaped payload when
    // a topics array was requested). Truncate to keep the log tidy.
    const head = raw.slice(0, 200).replace(/\s+/g, " ");
    const tail = raw.length > 400 ? raw.slice(-200).replace(/\s+/g, " ") : "";
    const sample = tail ? `${head} … ${tail}` : head;
    throw new Error(
      `Failed to parse topics JSON from Writer response (len=${raw.length}): ${sample}`,
    );
  }
  return JSON.parse(jsonMatch[0]) as ArticleTopic[];
}

export async function generateTopics(siteId: string, count = 10, existingKeywords: string[] = []): Promise<ArticleTopic[]> {
  const site = await getSiteConfig(siteId);
  const seedSample = site.seedKeywords.slice(0, 5).join(", ");

  const avoidSection = existingKeywords.length > 0
    ? `\nAlready covered — do NOT generate topics similar to these:\n${existingKeywords.map(k => `- ${k}`).join("\n")}\n`
    : "";

  const prompt = `Generate ${count} high-value SEO article topics for a site in the "${site.niche}" niche targeting ${site.targetAudience}.

For each topic provide:
- keyword: primary target keyword (specific, search-friendly, long-tail)
- title: SEO-optimized H1 title (50-60 chars)
- intent: one of: informational, commercial, transactional, navigational
- angle: unique hook for this article (1 sentence)
- estimatedWordCount: 1200-2000

Focus on long-tail keywords with clear search intent, evergreen where possible. Mix informational and commercial intent.

Seed keywords: ${seedSample}
Affiliate programs to weave in where relevant: ${site.affiliatePrograms.join(", ")}
${avoidSection}
Return ONLY a valid JSON array. No markdown, no explanation.`;

  const raw = await dispatchToWriter(prompt);
  return parseTopicsJson(raw);
}

export async function generateMediumTopics(count = 5): Promise<ArticleTopic[]> {
  const prompt = `Generate ${count} thought-leadership article ideas for Medium about AI orchestration, autonomous agents, and AI-powered entrepreneurship.

The author is building Nexus — an AI orchestration system with autonomous entities — and is an entrepreneur focused on automation and AI-powered business systems.

For each provide:
- keyword: core topic/theme
- title: compelling, insight-driven title (not clickbait)
- intent: "informational"
- angle: specific insight or argument that makes this worth reading
- estimatedWordCount: 1500-3000

Return ONLY a valid JSON array. No markdown, no explanation.`;

  const raw = await dispatchToWriter(prompt);
  return parseTopicsJson(raw);
}
