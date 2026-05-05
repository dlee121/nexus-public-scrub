/**
 * WordPress REST API publisher.
 * Uses application passwords for authentication.
 * Docs: https://developer.wordpress.org/rest-api/reference/posts/
 */

import { getSiteConfig } from "./config.ts";
import { searchUnsplash } from "./images.ts";
import type { Article } from "./types.ts";

interface WpPostResponse {
  id: number;
  link: string;
  status: string;
}

interface WpMediaResponse {
  id: number;
  source_url: string;
}

/**
 * Extract FAQ Q&As from HTML content and inject JSON-LD schema.
 * Targets H3 headings inside the FAQ section and their following <p> content.
 */
function injectSchema(content: string, article: Article, siteUrl: string): string {
  // Extract FAQ pairs: H3 (question) followed by <p> (answer)
  const faqPairs: { question: string; answer: string }[] = [];
  const faqSection = content.match(/<h2[^>]*>.*?[Ff]requently [Aa]sked.*?<\/h2>([\s\S]*?)(?=<h2|$)/i);
  if (faqSection) {
    const faqHtml = faqSection[1];
    const questionRe = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = questionRe.exec(faqHtml)) !== null) {
      const question = m[1].replace(/<[^>]+>/g, "").trim();
      const answer = m[2].replace(/<[^>]+>/g, "").trim();
      if (question && answer) faqPairs.push({ question, answer });
    }
  }

  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.metaDescription,
    url: `${siteUrl.replace(/\/$/, "")}/${article.slug}/`,
    datePublished: article.publishedAt ?? article.createdAt,
    dateModified: article.publishedAt ?? article.createdAt,
    author: { "@type": "Organization", name: siteUrl.replace(/https?:\/\//, "").replace(/\/$/, "") },
  };

  let schemaHtml = `<script type="application/ld+json">\n${JSON.stringify(articleSchema, null, 2)}\n</script>\n`;

  if (faqPairs.length > 0) {
    const faqSchema = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faqPairs.map((p) => ({
        "@type": "Question",
        name: p.question,
        acceptedAnswer: { "@type": "Answer", text: p.answer },
      })),
    };
    schemaHtml += `<script type="application/ld+json">\n${JSON.stringify(faqSchema, null, 2)}\n</script>\n`;
  }

  return schemaHtml + content;
}

interface WpCategoryResponse {
  id: number;
  name: string;
  slug: string;
}

interface WpTagResponse {
  id: number;
  name: string;
  slug: string;
}

function basicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

async function wpRequest<T>(
  url: string,
  method: string,
  auth: string,
  body?: object
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP API ${method} ${url} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function getOrCreateCategory(
  wpUrl: string,
  auth: string,
  name: string
): Promise<number> {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const existing = await wpRequest<WpCategoryResponse[]>(
    `${wpUrl}/wp-json/wp/v2/categories?slug=${slug}`,
    "GET",
    auth
  );
  if (existing.length > 0) return existing[0].id;

  const created = await wpRequest<WpCategoryResponse>(
    `${wpUrl}/wp-json/wp/v2/categories`,
    "POST",
    auth,
    { name, slug }
  );
  return created.id;
}

async function getOrCreateTag(
  wpUrl: string,
  auth: string,
  name: string
): Promise<number> {
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const existing = await wpRequest<WpTagResponse[]>(
    `${wpUrl}/wp-json/wp/v2/tags?slug=${slug}`,
    "GET",
    auth
  );
  if (existing.length > 0) return existing[0].id;

  const created = await wpRequest<WpTagResponse>(
    `${wpUrl}/wp-json/wp/v2/tags`,
    "POST",
    auth,
    { name, slug }
  );
  return created.id;
}

/**
 * Fetch an image from a URL and upload it to the WordPress media library.
 * Returns the WP media ID, or null if upload fails.
 */
async function uploadFeaturedImage(
  wpUrl: string,
  auth: string,
  imageUrl: string,
  filename: string,
  altText: string,
  caption: string
): Promise<number | null> {
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const bytes = await imgRes.arrayBuffer();
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";

    const res = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: bytes,
    });
    if (!res.ok) return null;

    const media = await res.json() as WpMediaResponse;

    // Set alt text and caption via PATCH
    await fetch(`${wpUrl}/wp-json/wp/v2/media/${media.id}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ alt_text: altText, caption }),
    });

    return media.id;
  } catch {
    return null;
  }
}

/**
 * Publish an article to WordPress.
 * @param article - The article to publish
 * @param status - "publish" for live, "draft" for review queue
 */
export async function publishToWordPress(
  article: Article,
  status: "publish" | "draft" = "publish"
): Promise<{ postId: number; url: string }> {
  const site = await getSiteConfig(article.siteId);
  const wp = site.wordpress;
  const auth = basicAuth(wp.username, wp.appPassword);
  const wpUrl = wp.url.replace(/\/$/, "");

  // Resolve category IDs
  const categoryIds = await Promise.all(
    article.categories.map((c) => getOrCreateCategory(wpUrl, auth, c))
  );

  // Resolve tag IDs
  const tagIds = await Promise.all(
    article.tags.map((t) => getOrCreateTag(wpUrl, auth, t))
  );

  // Fetch featured image from Unsplash and upload to WP
  let featuredMediaId: number | undefined;
  const photo = await searchUnsplash(article.topic.keyword);
  if (photo) {
    const filename = `${article.slug}-hero.jpg`;
    const mediaId = await uploadFeaturedImage(
      wpUrl, auth, photo.url, filename, photo.altText,
      `<a href="${photo.creditUrl}" rel="nofollow">${photo.credit}</a>`
    );
    if (mediaId) featuredMediaId = mediaId;
  }

  const enrichedContent = injectSchema(article.content, article, wpUrl);

  const post = await wpRequest<WpPostResponse>(
    `${wpUrl}/wp-json/wp/v2/posts`,
    "POST",
    auth,
    {
      title: article.title,
      content: enrichedContent,
      slug: article.slug,
      status,
      categories: categoryIds,
      tags: tagIds,
      excerpt: article.metaDescription,
      ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
      meta: {
        // Rank Math SEO fields
        rank_math_focus_keyword: article.topic.keyword,
        rank_math_description: article.metaDescription,
      },
    }
  );

  return { postId: post.id, url: post.link };
}

/**
 * Update an existing WordPress post by ID with new content.
 */
export async function updateWordPressPost(
  siteId: string,
  postId: number,
  article: Article
): Promise<{ postId: number; url: string }> {
  const site = await getSiteConfig(siteId);
  const wp = site.wordpress;
  const auth = basicAuth(wp.username, wp.appPassword);
  const wpUrl = wp.url.replace(/\/$/, "");

  const categoryIds = await Promise.all(
    article.categories.map((c) => getOrCreateCategory(wpUrl, auth, c))
  );
  const tagIds = await Promise.all(
    article.tags.map((t) => getOrCreateTag(wpUrl, auth, t))
  );

  const enrichedContent = injectSchema(article.content, article, wpUrl);

  const post = await wpRequest<WpPostResponse>(
    `${wpUrl}/wp-json/wp/v2/posts/${postId}`,
    "POST",
    auth,
    {
      title: article.title,
      content: enrichedContent,
      slug: article.slug,
      status: "publish",
      categories: categoryIds,
      tags: tagIds,
      excerpt: article.metaDescription,
      meta: {
        rank_math_focus_keyword: article.topic.keyword,
        rank_math_description: article.metaDescription,
      },
    }
  );

  return { postId: post.id, url: post.link };
}

/**
 * Publish an article to WordPress and return an updated Article with
 * status, publishedUrl, externalId, and publishedAt filled in.
 * Convenience wrapper used by the dashboard's one-click publish action.
 */
export async function publishArticle(article: Article): Promise<Article> {
  const { postId, url } = await publishToWordPress(article);
  return {
    ...article,
    status: "published",
    publishedUrl: url,
    externalId: String(postId),
    publishedAt: new Date().toISOString(),
    error: null,
  };
}
