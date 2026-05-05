/**
 * Telegram notification helper for the content pipeline.
 *
 * Channel-siloed per the Nexus rule: content pipeline → Telegram only,
 * Forge updates → Slack only. Don't import this from forge-* code.
 *
 * Sends are JSON-bodied (not form-urlencoded) so newlines and special
 * characters land cleanly without ambiguous bash quoting. parse_mode is
 * opt-in — default is plain text, which is safer for arbitrary article
 * titles that may contain Markdown-significant characters (`*`, `_`, `[`,
 * `]`, etc.) without preprocessing.
 *
 * Best-effort: a Telegram failure NEVER throws — failures log to stderr
 * so the pipeline continues. Notifications are observability, not
 * correctness.
 */

import { readFileSync } from "fs";
import { join } from "path";

const TELEGRAM_MAX_LEN = 4096;
const NEXUS_CORE = process.env.NEXUS_CORE_PATH ?? "/Users/<user>/Nexus/core";

interface TelegramConfig {
  token: string;
  chatId: number;
}

interface SendOpts {
  /** Optional Markdown parsing. Default omitted (plain text). */
  parseMode?: "Markdown" | "MarkdownV2";
  /** Whether to render link previews. Default true. */
  preview?: boolean;
}

function loadConfig(): TelegramConfig | null {
  try {
    const settingsPath = join(NEXUS_CORE, ".claude/claudeclaw/settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      telegram?: { token?: string; allowedUserIds?: number[] };
    };
    const token = settings.telegram?.token ?? "";
    const chatId = settings.telegram?.allowedUserIds?.[0];
    if (!token || typeof chatId !== "number") return null;
    return { token, chatId };
  } catch {
    return null;
  }
}

/**
 * Send a single message to the configured Telegram chat. Chunks at 4096
 * chars on paragraph boundaries when possible. Best-effort — never throws.
 */
export async function sendTelegram(
  message: string,
  opts: SendOpts = {},
): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    process.stderr.write(
      "[telegram] config not found in .claude/claudeclaw/settings.json — skipping\n",
    );
    return;
  }

  const { parseMode, preview = true } = opts;
  const text = message;

  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + TELEGRAM_MAX_LEN, text.length);
    if (end < text.length) {
      // Prefer breaking on a paragraph boundary, then a single newline,
      // then a space, before doing a hard cut. Search the back half of
      // the chunk so we don't ship tiny fragments.
      const slice = text.slice(i, end);
      const halfway = TELEGRAM_MAX_LEN / 2;
      const lastPara = slice.lastIndexOf("\n\n");
      const lastNl = slice.lastIndexOf("\n");
      const lastSpace = slice.lastIndexOf(" ");
      const cut =
        lastPara > halfway ? lastPara
        : lastNl > halfway ? lastNl
        : lastSpace > halfway ? lastSpace
        : -1;
      if (cut > 0) end = i + cut;
    }
    const chunk = text.slice(i, end);
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${cfg.token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text: chunk,
            ...(parseMode ? { parse_mode: parseMode } : {}),
            disable_web_page_preview: !preview,
          }),
        },
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        process.stderr.write(
          `[telegram] HTTP ${resp.status}: ${body.slice(0, 200)}\n`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[telegram] send failed: ${msg}\n`);
    }
    i = end;
  }
}
