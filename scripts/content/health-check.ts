#!/usr/bin/env bun
/**
 * Content pipeline health check — for Monitor to run.
 * Checks: env config, WordPress connectivity, queue state, last publish time.
 *
 * Usage: bun scripts/content/health-check.ts [--alert-only]
 * Exit: 0 = healthy, 1 = warnings, 2 = critical
 */

import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAnthropicKey, getSiteConfig, getAllSiteIds } from "./config.ts";
import { queueStats, listQueue } from "./queue.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const alertOnly = process.argv.includes("--alert-only");

type Severity = "ok" | "warn" | "critical";
interface Check { name: string; status: Severity; message: string }

const checks: Check[] = [];

function record(name: string, status: Severity, message: string) {
  checks.push({ name, status, message });
  if (!alertOnly || status !== "ok") {
    const icon = status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
    console.log(`${icon} ${name}: ${message}`);
  }
}

// ── 1. Env / API Key ─────────────────────────────────────────────────────────

try {
  const key = await getAnthropicKey();
  if (key.startsWith("sk-ant-")) {
    record("anthropic-key", "ok", "API key present and valid format");
  } else {
    record("anthropic-key", "warn", "Key present but unexpected format");
  }
} catch {
  // Pipeline routes through Writer (Nexus entity) — no direct API key required
  record("anthropic-key", "ok", "Pipeline uses Nexus/Writer — no direct API key needed");
}

// ── 2. Config file ───────────────────────────────────────────────────────────

const configFile = join(ROOT, "config/content-sites.json");
if (existsSync(configFile)) {
  record("config-file", "ok", "content-sites.json found");
} else {
  record("config-file", "critical", "config/content-sites.json missing");
}

// ── 3. WordPress connectivity ────────────────────────────────────────────────

const siteIds = await getAllSiteIds();
for (const siteId of siteIds) {
  try {
    const site = await getSiteConfig(siteId);
    const { url, username, appPassword } = site.wordpress;

    if (url.includes("PLACEHOLDER") || username.includes("PLACEHOLDER")) {
      record(`wp-${siteId}`, "warn", "Not yet configured (PLACEHOLDER values)");
      continue;
    }

    const credentials = Buffer.from(`${username}:${appPassword}`).toString("base64");
    const res = await fetch(`${url}/wp-json/wp/v2/posts?per_page=1`, {
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      record(`wp-${siteId}`, "ok", `${url} reachable (${res.status})`);
    } else if (res.status === 401) {
      record(`wp-${siteId}`, "critical", `Auth failed (401) — check app password for ${siteId}`);
    } else {
      record(`wp-${siteId}`, "warn", `HTTP ${res.status} from ${url}`);
    }
  } catch (e: any) {
    record(`wp-${siteId}`, e?.message?.includes("PLACEHOLDER") ? "warn" : "critical",
      `Connection failed: ${e?.message || e}`);
  }
}

// ── 4. Queue stats ───────────────────────────────────────────────────────────

try {
  const stats = await queueStats();
  const total = stats.pending + stats.ready + stats.published + stats.failed;

  if (stats.failed > 3) {
    record("queue-failed", "warn", `${stats.failed} articles in failed state — review errors`);
  } else {
    record("queue-failed", "ok", `${stats.failed} failed (acceptable)`);
  }

  if (stats.ready > 20) {
    record("queue-backlog", "warn", `${stats.ready} ready articles unPublished — publish backlog building up`);
  } else {
    record("queue-backlog", "ok", `${stats.ready} ready, ${stats.published} published (${total} total)`);
  }

  // Check staleness: if no articles published in last 3 days, warn
  const published = await listQueue({ status: "published" });
  if (published.length > 0) {
    const latest = published
      .map((a) => a.publishedAt ? new Date(a.publishedAt).getTime() : 0)
      .sort((a, b) => b - a)[0];
    const daysSince = (Date.now() - latest) / (1000 * 60 * 60 * 24);
    if (daysSince > 3) {
      record("queue-freshness", "warn", `Last publish was ${daysSince.toFixed(1)} days ago — cron may be stalled`);
    } else {
      record("queue-freshness", "ok", `Last publish ${daysSince.toFixed(1)} days ago`);
    }
  } else {
    record("queue-freshness", "ok", "No published articles yet (fresh install)");
  }
} catch (e) {
  record("queue", "warn", `Could not read queue: ${e}`);
}

// ── 5. Cron status ───────────────────────────────────────────────────────────

try {
  const proc = Bun.spawn(["crontab", "-l"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const hasDailyCron = out.includes("pipeline.ts daily");
  const hasMediumCron = out.includes("pipeline.ts medium");

  if (hasDailyCron && hasMediumCron) {
    record("cron", "ok", "Daily and Medium cron jobs installed");
  } else if (hasDailyCron || hasMediumCron) {
    record("cron", "warn", "Only partial cron jobs installed — run: crontab data/content/crontab.txt");
  } else {
    record("cron", "warn", "No content cron jobs found — run: crontab data/content/crontab.txt");
  }
} catch {
  record("cron", "warn", "Could not check crontab");
}

// ── Summary ──────────────────────────────────────────────────────────────────

const criticals = checks.filter((c) => c.status === "critical").length;
const warnings = checks.filter((c) => c.status === "warn").length;
const oks = checks.filter((c) => c.status === "ok").length;

console.log(`\n── Summary: ${oks} ok, ${warnings} warnings, ${criticals} critical ──`);

if (criticals > 0) {
  console.log("Status: CRITICAL — pipeline cannot run");
  process.exit(2);
} else if (warnings > 0) {
  console.log("Status: DEGRADED — pipeline may run with issues");
  process.exit(1);
} else {
  console.log("Status: HEALTHY");
  process.exit(0);
}
