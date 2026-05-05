import { runUserMessage } from "../runner";
import { getSettings } from "../config";
import { join } from "node:path";
import { relayToSlack, sendMessage, recordSentTs, wasSentByMe } from "../lib/slack-relay";

export { sendMessage, recordSentTs };

// --- Types ---

interface SlackConfig {
  token: string;
  channelId: string;
  allowedUserIds: string[];
}

interface SlackMessage {
  type: string;
  ts: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
}

interface SlackHistoryResult {
  ok: boolean;
  messages?: SlackMessage[];
  error?: string;
  response_metadata?: { next_cursor?: string };
}

// --- State ---

let slackDebug = false;
const LAST_TS_FILE = join(process.cwd(), ".claude", "claudeclaw", "slack-last-ts.json");

function debugLog(msg: string) {
  if (slackDebug) console.log(`[Slack debug] ${msg}`);
}

// --- Slack API ---

async function callSlack<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Slack API ${method} HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

async function addReaction(token: string, channelId: string, ts: string, emoji: string): Promise<void> {
  await callSlack<{ ok: boolean; error?: string }>(token, "reactions.add", {
    channel: channelId,
    timestamp: ts,
    name: emoji,
  }).catch((err) => {
    console.error(`[Slack] Failed to add reaction: ${err instanceof Error ? err.message : err}`);
  });
}

// --- Last-seen timestamp persistence ---

async function loadLastTs(): Promise<string> {
  try {
    const data = await Bun.file(LAST_TS_FILE).json() as { ts?: string };
    return data.ts ?? "0";
  } catch {
    return "0";
  }
}

async function saveLastTs(ts: string): Promise<void> {
  await Bun.write(LAST_TS_FILE, JSON.stringify({ ts }));
}

// --- Message handler ---

/**
 * Inbound tag-based pre-handling. Lets DK (or any allowed user) annotate a
 * message with a leading bracket-tag to control how this handler reacts
 * before spawning Orchestrator. Returns true if the message was fully handled and
 * the caller should return.
 *
 *   [ignore]   — log + drop. No reaction, no Orchestrator spawn.
 *   [ack]      — react ✅ and stop. Useful for "got it, no reply needed".
 *
 * Anything else falls through to the normal Orchestrator flow. The tags are
 * matched case-insensitively, anchored at the start of trimmed text.
 */
async function handleInboundTag(cfg: SlackConfig, msgTs: string, text: string): Promise<boolean> {
  const t = text.trimStart().toLowerCase();
  if (t.startsWith("[ignore]")) {
    console.log(`[Slack] [ignore] tag — dropping msg ts=${msgTs}`);
    return true;
  }
  if (t.startsWith("[ack]")) {
    console.log(`[Slack] [ack] tag — reacting and stopping msg ts=${msgTs}`);
    await addReaction(cfg.token, cfg.channelId, msgTs, "white_check_mark");
    return true;
  }
  return false;
}

async function handleMessage(cfg: SlackConfig, userId: string, text: string, msgTs: string): Promise<void> {
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${userId}: "${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`
  );

  // Inbound tag pre-handling — short-circuit before we spawn Orchestrator when the
  // operator has flagged the message [ignore] or [ack].
  if (await handleInboundTag(cfg, msgTs, text)) return;

  // Acknowledge immediately with a ⚡ reaction so the user knows it landed
  await addReaction(cfg.token, cfg.channelId, msgTs, "zap");

  const prefixedPrompt = `[Slack from ${userId}]\nMessage: ${text}`;

  try {
    const runStart = Date.now();
    const result = await runUserMessage("slack", prefixedPrompt);
    const elapsedMs = Date.now() - runStart;

    // Relay Orchestrator's output to Slack with all suppression rules
    // (slackPostsMade, [no-relay] tag, raw-JSON guard, exit-code error
    // framing). Logic lives in lib/slack-relay.ts so the same flow runs
    // for the `send` command too — see PR fixing the auto-relay gap on
    // delegated-task-complete continuation turns.
    await relayToSlack(result, elapsedMs, { token: cfg.token, channelId: cfg.channelId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${userId}: ${msg}`);
    await sendMessage(cfg.token, cfg.channelId, `⚡ *Orchestrator* — Error: ${msg}`);
  }
}

// --- Polling loop ---

let running = true;

async function poll(): Promise<void> {
  const cfg = getSettings().slack;

  let lastTs = await loadLastTs();
  if (lastTs === "0") {
    // Initialize to now so we don't replay old messages on first start
    lastTs = String(Date.now() / 1000);
    await saveLastTs(lastTs);
  }

  console.log("Slack bot started (polling)");
  console.log(`  Channel: ${cfg.channelId}`);
  console.log(`  Allowed users: ${cfg.allowedUserIds.length === 0 ? "all" : cfg.allowedUserIds.join(", ")}`);

  while (running) {
    try {
      await Bun.sleep(3000);

      const data = await callSlack<SlackHistoryResult>(cfg.token, "conversations.history", {
        channel: cfg.channelId,
        oldest: lastTs,
        limit: 10,
      });

      if (!data.ok) {
        console.error(`[Slack] conversations.history error: ${data.error}`);
        continue;
      }

      const messages = (data.messages ?? []).slice().reverse(); // oldest first

      for (const msg of messages) {
        // Always advance cursor past this message
        lastTs = msg.ts;

        // Skip bot/app messages (our own responses)
        if (msg.bot_id || msg.app_id) {
          debugLog(`Skipping bot message ts=${msg.ts}`);
          continue;
        }

        // Skip messages we sent ourselves (e.g. file upload initial_comment via user token)
        if (wasSentByMe(msg.ts)) {
          debugLog(`Skipping own message ts=${msg.ts}`);
          continue;
        }

        if (!msg.user) continue;

        if (cfg.allowedUserIds.length > 0 && !cfg.allowedUserIds.includes(msg.user)) {
          console.log(`[Slack] Ignoring unauthorized user ${msg.user}`);
          continue;
        }

        const text = (msg.text ?? "").trim();
        if (!text) continue;

        await saveLastTs(lastTs);
        // Fire async — don't block the poll loop. handleMessage posts its own result to Slack when done.
        handleMessage(cfg, msg.user, text, msg.ts).catch((err: unknown) => {
          const msg2 = err instanceof Error ? err.message : String(err);
          console.error(`[Slack] Unhandled error in handleMessage: ${msg2}`);
          // Best-effort: try to notify the channel
          sendMessage(cfg.token, cfg.channelId, `⚡ *Orchestrator* — Error: ${msg2}`).catch(() => {});
        });
      }

      if (messages.length > 0) {
        await saveLastTs(lastTs);
      }
    } catch (err) {
      if (!running) break;
      console.error(`[Slack] Poll error: ${err instanceof Error ? err.message : err}`);
      await Bun.sleep(5000);
    }
  }
}

// --- Exports ---

process.on("SIGTERM", () => {
  running = false;
});
process.on("SIGINT", () => {
  running = false;
});

export function startPolling(debug = false): void {
  slackDebug = debug;
  (async () => {
    try {
      await poll();
    } catch (err) {
      console.error(`[Slack] Fatal polling error: ${err instanceof Error ? err.message : err}`);
    }
  })();
}
