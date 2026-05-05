import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import type { ContentConfig, SiteConfig, MediumConfig } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Load .env file if present (data/content/.env takes precedence, then root .env)
async function loadDotEnv(): Promise<void> {
  for (const envPath of [join(ROOT, "data/content/.env"), join(ROOT, ".env")]) {
    if (!existsSync(envPath)) continue;
    try {
      const raw = await readFile(envPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !process.env[key]) process.env[key] = val;
      }
    } catch {}
    break;
  }
}

let _envLoaded = false;
async function ensureEnv(): Promise<void> {
  if (_envLoaded) return;
  await loadDotEnv();
  _envLoaded = true;
}

export const DATA_DIR = join(ROOT, "data/content");
export const QUEUE_DIR = join(DATA_DIR, "queue");
export const PUBLISHED_DIR = join(DATA_DIR, "published");
export const CONFIG_PATH = join(ROOT, "config/content-sites.json");

let _config: ContentConfig | null = null;

export async function loadConfig(): Promise<ContentConfig> {
  if (_config) return _config;
  const raw = await readFile(CONFIG_PATH, "utf-8");
  _config = JSON.parse(raw) as ContentConfig;
  return _config;
}

export async function getSiteConfig(siteId: string): Promise<SiteConfig> {
  const cfg = await loadConfig();
  const site = cfg.sites[siteId];
  if (!site) throw new Error(`Unknown site: ${siteId}`);
  return site;
}

export async function getMediumConfig(): Promise<MediumConfig> {
  const cfg = await loadConfig();
  return cfg.medium;
}

export async function getAllSiteIds(): Promise<string[]> {
  const cfg = await loadConfig();
  return Object.keys(cfg.sites);
}

export async function getAnthropicKey(): Promise<string> {
  await ensureEnv();
  // Also accept ANTHROPIC_AUTH_TOKEN (used internally by Nexus)
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY not set.\n" +
      "Add it to data/content/.env:\n" +
      "  ANTHROPIC_API_KEY=sk-ant-..."
    );
  }
  return key;
}

export const ENV_FILE = join(ROOT, "data/content/.env");
export const ENV_EXAMPLE = join(ROOT, "data/content/.env.example");
