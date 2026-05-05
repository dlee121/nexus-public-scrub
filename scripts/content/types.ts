export type ArticleStatus = "pending" | "ready" | "published" | "failed";
export type ChannelType = "wordpress" | "medium";

export interface ArticleTopic {
  keyword: string;
  title: string;
  intent: "informational" | "commercial" | "transactional" | "navigational";
  angle: string;
  estimatedWordCount: number;
  internalLinks?: string[]; // keywords of related articles to link to
}

export interface Article {
  id: string;
  siteId: string; // "ai-tools" | "productivity" | "saas" | "medium"
  channel: ChannelType;
  topic: ArticleTopic;
  title: string;
  metaDescription: string;
  slug: string;
  content: string; // HTML
  categories: string[];
  tags: string[];
  wordCount: number;
  status: ArticleStatus;
  createdAt: string;
  readyAt: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  externalId: string | null; // WP post ID or Medium post ID
  error: string | null;
}

export interface SiteConfig {
  id: string;
  name: string;
  domain: string;
  niche: string;
  targetAudience: string;
  monetization: string[];
  affiliatePrograms: string[];
  wordpress: {
    url: string;
    username: string;
    appPassword: string;
  };
  seedKeywords: string[];
  categories: string[];
  publishSchedule: {
    articlesPerDay: number;
    preferredHour: number;
  };
}

export interface MediumConfig {
  enabled: boolean;
  integrationToken: string;
  authorId: string;
  publicationId: string | null;
  tags: string[];
  publishSchedule: {
    articlesPerWeek: number;
    preferredDay: string;
  };
}

export interface ContentConfig {
  sites: Record<string, SiteConfig>;
  medium: MediumConfig;
}
