/**
 * Shared Slack relay for Orchestrator's runUserMessage output.
 *
 * Single source of truth for the auto-relay logic that posts Orchestrator's
 * plain-text response to Slack after a turn. Used by:
 *   - src/commands/slack.ts — the inbound DM handler (the original site).
 *   - src/commands/send.ts  — the CLI inject path used by src/notify.ts
 *     to deliver delegated-task results back into Orchestrator's session, and
 *     by any caller that wants Orchestrator's response routed to Slack.
 *
 * Without this module, send-triggered turns produced output that never
 * reached DK in Slack — including continuation turns ("Continue from
 * where you left off…") spawned after wakeups or after delegated tasks
 * completed. The relay was previously inlined inside the Slack inbound
 * handler, so any other entry point fell silent.
 *
 * Suppression rules (preserved verbatim from the original slack.ts impl):
 *   - skip if Orchestrator already posted via MCP this turn (slackPostsMade > 0)
 *   - skip if Orchestrator's output starts with `[no-relay]`
 *   - on raw-stream-json output, post a safe error message instead
 *   - on non-zero exitCode, post a framed error message
 *   - if no Slack token/channel is configured, log + skip silently
 */

import { getLastRunSlackPostsMade, getLastRunEntities, type RunResult } from "../runner";

export interface SlackRelayConfig {
  token: string;
  channelId: string;
}

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

// ── Self-post tracking ────────────────────────────────────────────────
//
// The Slack polling loop in commands/slack.ts uses `wasSentByMe(ts)` to
// skip messages this process posted itself (otherwise Orchestrator would chase
// its own tail). State lives here, in the same module that posts, so
// recording is atomic with sending and there's no risk of a fork
// between the post path and the dedupe check.

const sentTs = new Set<string>();

export function wasSentByMe(ts: string): boolean {
  return sentTs.has(ts);
}

export function recordSentTs(ts: string): void {
  sentTs.add(ts);
}

// ── Slack chat.postMessage ────────────────────────────────────────────

interface PostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

export async function sendMessage(
  token: string,
  channelId: string,
  text: string,
): Promise<string> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  if (!resp.ok) throw new Error(`Slack API HTTP ${resp.status}`);
  const data = (await resp.json()) as PostResult;
  if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
  const ts = data.ts ?? "";
  if (ts) sentTs.add(ts);
  return ts;
}

// ── Relay helpers ─────────────────────────────────────────────────────

function cleanResponse(text: string): string {
  return text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasNoRelayTag(text: string): boolean {
  return /^\s*\[no-relay\]/i.test(text);
}

function formatElapsed(elapsedMs: number): string {
  return elapsedMs < 60000
    ? (elapsedMs / 1000).toFixed(1) + "s"
    : Math.floor(elapsedMs / 60000) + "m " + Math.floor((elapsedMs % 60000) / 1000) + "s";
}

/**
 * Post Orchestrator's runUserMessage result to Slack, applying all suppression
 * rules. Failures during the Slack post are caught and logged but not
 * re-thrown — relay is observability, not correctness; a Slack outage
 * shouldn't break the calling command.
 */
export async function relayToSlack(
  result: RunResult,
  elapsedMs: number,
  cfg: SlackRelayConfig,
): Promise<void> {
  if (!cfg.token || !cfg.channelId) {
    console.log("[slack-relay] No Slack token/channel configured; skipping relay.");
    return;
  }

  try {
    if (result.exitCode !== 0) {
      const errorText = result.exitCode === 124
        ? "This task timed out. Please re-send to retry — if it consistently times out, try breaking it into smaller steps."
        : `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`;
      await sendMessage(
        cfg.token,
        cfg.channelId,
        `${DIVIDER}\n⚡ *Orchestrator*\n\n${errorText}\n\n${DIVIDER}`,
      );
      return;
    }

    const slackPostsMade = getLastRunSlackPostsMade();
    if (slackPostsMade > 0) {
      console.log(
        `[slack-relay] Skipping: Orchestrator made ${slackPostsMade} direct Slack post(s) during this turn.`,
      );
      return;
    }

    const cleaned = cleanResponse(result.stdout || "");

    if (hasNoRelayTag(cleaned)) {
      console.log("[slack-relay] Skipping: [no-relay] tag on Orchestrator's output.");
      return;
    }

    if (
      cleaned.startsWith('{"type":') ||
      cleaned.includes('"subtype":"init"') ||
      cleaned.includes('"session_id"')
    ) {
      await sendMessage(
        cfg.token,
        cfg.channelId,
        `${DIVIDER}\n⚡ *Orchestrator*\n\nSession output was malformed (raw JSON detected). Please retry your message.\n\n${DIVIDER}`,
      );
      return;
    }

    const elapsedStr = formatElapsed(elapsedMs);
    const subNames = getLastRunEntities();
    const footer = `_— ⚡ orchestrator · ${elapsedStr}${subNames.length ? ` · via ${subNames.join(", ")}` : ""}_`;
    const body = `${DIVIDER}\n⚡ *Orchestrator*\n\n${cleaned || "(empty response)"}\n\n${footer}\n${DIVIDER}`;
    await sendMessage(cfg.token, cfg.channelId, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[slack-relay] Post failed: ${msg}`);
  }
}
