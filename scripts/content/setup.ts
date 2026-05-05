#!/usr/bin/env bun
/**
 * First-time setup wizard for the content publishing pipeline.
 * Run once: bun scripts/content/setup.ts
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = join(ROOT, "data/content/.env");
const CONFIG_FILE = join(ROOT, "config/content-sites.json");

function ask(question: string): Promise<string> {
  process.stdout.write(question + " ");
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      data = String(chunk).trim();
      process.stdin.pause();
      resolve(data);
    });
  });
}

async function setEnvVar(envLines: string[], key: string, value: string): Promise<string[]> {
  const idx = envLines.findIndex((l) => l.startsWith(key + "="));
  const line = `${key}=${value}`;
  if (idx === -1) return [...envLines, line];
  const updated = [...envLines];
  updated[idx] = line;
  return updated;
}

async function main() {
  await mkdir(join(ROOT, "data/content"), { recursive: true });

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Nexus Content Pipeline — First-Time Setup       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log("This wizard will configure your credentials.");
  console.log("Values are saved to data/content/.env (gitignored).\n");

  // Load existing .env if present
  let envLines: string[] = [];
  if (existsSync(ENV_FILE)) {
    const raw = await readFile(ENV_FILE, "utf-8");
    envLines = raw.split("\n");
    console.log("Found existing .env — updating values.\n");
  } else {
    const example = await readFile(join(ROOT, "data/content/.env.example"), "utf-8");
    envLines = example.split("\n");
  }

  // ── Anthropic API Key ──────────────────────────────────────
  const existingKey = envLines.find((l) => l.startsWith("ANTHROPIC_API_KEY="))?.split("=")[1] || "";
  const maskedKey = existingKey ? `[current: sk-ant-...${existingKey.slice(-6)}]` : "[not set]";
  const apiKey = await ask(`Anthropic API key ${maskedKey} (enter to keep):`);
  if (apiKey) envLines = await setEnvVar(envLines, "ANTHROPIC_API_KEY", apiKey);

  // ── Medium Token ─────────────────────────────────────────────
  const mediumToken = await ask("Medium integration token [enter to skip]:");
  if (mediumToken) envLines = await setEnvVar(envLines, "MEDIUM_INTEGRATION_TOKEN", mediumToken);

  // ── WordPress Sites ──────────────────────────────────────────
  const configRaw = await readFile(CONFIG_FILE, "utf-8");
  const config = JSON.parse(configRaw);
  let configChanged = false;

  for (const [siteId, site] of Object.entries(config.sites) as [string, any][]) {
    console.log(`\n── WordPress: ${site.name} (${siteId}) ──`);
    const hasConfig = site.wordpress?.url && !site.wordpress.url.includes("PLACEHOLDER");
    if (hasConfig) {
      console.log(`  URL: ${site.wordpress.url} [configured]`);
      const update = await ask("  Update credentials? (y/N):");
      if (update.toLowerCase() !== "y") continue;
    } else {
      console.log("  Not yet configured — skip if VPS not ready yet.");
      const skip = await ask("  Configure now? (y/N):");
      if (skip.toLowerCase() !== "y") continue;
    }

    const url = await ask(`  WordPress URL (e.g. https://yoursite.com):`);
    const user = await ask(`  WordPress username:`);
    const pass = await ask(`  Application password (from WP Admin → Users → Profile):`);

    if (url && user && pass) {
      config.sites[siteId].wordpress = { url: url.replace(/\/$/, ""), username: user, appPassword: pass };
      configChanged = true;
      console.log(`  ✓ ${siteId} configured`);
    }
  }

  // ── Medium author ID ─────────────────────────────────────────
  if (mediumToken && mediumToken !== "skip") {
    config.medium.integrationToken = mediumToken;
    configChanged = true;
  }

  // ── Save ──────────────────────────────────────────────────────
  await writeFile(ENV_FILE, envLines.join("\n"));
  console.log(`\n✓ Saved credentials to data/content/.env`);

  if (configChanged) {
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log("✓ Updated config/content-sites.json");
  }

  // ── Test API key ──────────────────────────────────────────────
  const keyToTest = apiKey || existingKey;
  if (keyToTest && keyToTest.startsWith("sk-ant-")) {
    console.log("\nTesting Anthropic API key...");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": keyToTest,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 10,
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      if (res.ok) {
        console.log("✓ Anthropic API key is valid");
      } else {
        console.log(`✗ API key test failed: ${res.status}`);
      }
    } catch (e) {
      console.log(`✗ API key test error: ${e}`);
    }
  }

  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  Setup complete. Next steps:                      ║");
  console.log("║                                                    ║");
  console.log("║  1. Deploy WordPress sites (see Engineer task)       ║");
  console.log("║  2. Run: bun scripts/content/pipeline.ts topics    ║");
  console.log("║  3. Run: bun scripts/content/pipeline.ts write     ║");
  console.log("║  4. Install cron: bun scripts/content/cron.sh      ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
