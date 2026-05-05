/**
 * Medium API publisher.
 * Uses Medium's Integration Token API.
 * Docs: https://github.com/Medium/medium-api-docs
 */

import { getMediumConfig } from "./config.ts";
import type { Article } from "./types.ts";

interface MediumPostResponse {
  data: {
    id: string;
    url: string;
    canonicalUrl: string;
    publishStatus: string;
  };
}

interface MediumUserResponse {
  data: {
    id: string;
    username: string;
    name: string;
    url: string;
  };
}

async function mediumRequest<T>(
  path: string,
  method: string,
  token: string,
  body?: object
): Promise<T> {
  const res = await fetch(`https://api.medium.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Medium API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function getMediumUserId(token: string): Promise<string> {
  const res = await mediumRequest<MediumUserResponse>("/me", "GET", token);
  return res.data.id;
}

/**
 * Publish an article to Medium.
 * @param article - The article to publish
 * @param publishStatus - "public", "draft", or "unlisted"
 */
export async function publishToMedium(
  article: Article,
  publishStatus: "public" | "draft" | "unlisted" = "draft"
): Promise<{ postId: string; url: string }> {
  const cfg = await getMediumConfig();
  const token = cfg.integrationToken;

  // Resolve author ID
  let authorId = cfg.authorId;
  if (!authorId || authorId === "PLACEHOLDER_MEDIUM_AUTHOR_ID") {
    authorId = await getMediumUserId(token);
  }

  const tags = [
    ...article.tags,
    ...cfg.tags,
  ]
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 5); // Medium max 5 tags

  const endpoint = cfg.publicationId
    ? `/publications/${cfg.publicationId}/posts`
    : `/users/${authorId}/posts`;

  const res = await mediumRequest<MediumPostResponse>(endpoint, "POST", token, {
    title: article.title,
    contentFormat: "html",
    content: `<h1>${article.title}</h1>\n${article.content}`,
    tags,
    publishStatus,
    notifyFollowers: publishStatus === "public",
  });

  return { postId: res.data.id, url: res.data.url };
}
