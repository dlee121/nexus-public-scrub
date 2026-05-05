import { join } from "path";
import type { Task } from "./tasks";
import { loadNexus, type NexusEntity } from "./nexus";

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
const TELEGRAM_MAX_LEN = 4096;

type NotifyChannel = "slack" | "telegram" | "none";

function cleanText(text: string): string {
  return text
    .replace(/\[react:[^\]\r\n]+\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fmtElapsed(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 60000
    ? (ms / 1000).toFixed(1) + "s"
    : Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
}

function resolveChannel(entity: NexusEntity | null): NotifyChannel {
  if (!entity) return "slack";
  if (entity.notify === false) return "none";
  const ch = entity.notifyChannel;
  if (ch === "telegram" || ch === "none") return ch;
  return "slack";
}

async function getSlackConfig(orchestratorPath: string): Promise<{ token: string; channelId: string } | null> {
  try {
    const settingsPath = join(orchestratorPath, ".claude/claudeclaw/settings.json");
    const settings = await Bun.file(settingsPath).json() as { slack?: { token?: string; channelId?: string } };
    const token = settings.slack?.token ?? "";
    const channelId = settings.slack?.channelId ?? "";
    if (!token || !channelId) return null;
    return { token, channelId };
  } catch {
    return null;
  }
}

async function getTelegramConfig(orchestratorPath: string): Promise<{ token: string; chatId: number } | null> {
  try {
    const settingsPath = join(orchestratorPath, ".claude/claudeclaw/settings.json");
    const settings = await Bun.file(settingsPath).json() as { telegram?: { token?: string; allowedUserIds?: number[] } };
    const token = settings.telegram?.token ?? "";
    const chatId = settings.telegram?.allowedUserIds?.[0];
    if (!token || typeof chatId !== "number") return null;
    return { token, chatId };
  } catch {
    return null;
  }
}

async function postSlackMessage(token: string, channelId: string, text: string): Promise<void> {
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  if (!resp.ok) throw new Error(`Slack API HTTP ${resp.status}`);
  const data = await resp.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(`chat.postMessage failed: ${data.error}`);
}

async function postTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  // Telegram caps at 4096 chars per message. Chunk on a paragraph boundary
  // when possible so split points don't land mid-word.
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    let end = Math.min(i + TELEGRAM_MAX_LEN, text.length);
    if (end < text.length) {
      const slice = text.slice(i, end);
      const lastPara = slice.lastIndexOf("\n\n");
      const lastNl = slice.lastIndexOf("\n");
      const cut = lastPara > TELEGRAM_MAX_LEN / 2 ? lastPara
        : lastNl > TELEGRAM_MAX_LEN / 2 ? lastNl
        : -1;
      if (cut > 0) end = i + cut;
    }
    const chunk = text.slice(i, end);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }),
    });
    if (!resp.ok) throw new Error(`Telegram API HTTP ${resp.status}`);
    const data = await resp.json() as { ok: boolean; description?: string };
    if (!data.ok) throw new Error(`sendMessage failed: ${data.description}`);
    if (end === text.length) break;
    i = end - TELEGRAM_MAX_LEN;
  }
}

async function injectIntoOrchestratorSession(corePath: string, orchestratorPath: string, message: string): Promise<void> {
  // --inject signals to commands/send.ts that this is a delegated-task
  // result relay (not a manual operator CLI call). The send command
  // uses a much shorter Claude session timeout for inject calls (5 min
  // vs 30 min default) so a stuck inject can't block incoming user
  // messages on the cross-process session lock for half an hour.
  const proc = Bun.spawn(
    ["bun", "run", join(corePath, "src/index.ts"), "send", "--inject", message],
    {
      cwd: orchestratorPath,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }
  );
  await proc.exited;
}

function buildSlackBody(task: Task): string {
  if (task.status === "completed") {
    const result = cleanText(task.result ?? "(no output)");
    const elapsed = fmtElapsed(task.startedAt, task.completedAt);
    const footerParts = [`⚡ orchestrator · via ${task.to}`];
    if (elapsed) footerParts.push(elapsed);
    const footer = `_— ${footerParts.join(" · ")}_`;
    return `${DIVIDER}\n⚡ *Orchestrator*\n\n${result || "(empty)"}\n\n${footer}\n${DIVIDER}`;
  }
  const err = cleanText(task.error ?? "Unknown error");
  return `${DIVIDER}\n⚡ *Orchestrator*\n\n❌ Task failed (via ${task.to}): ${err}\n\n${DIVIDER}`;
}

function buildTelegramBody(task: Task): string {
  // Plain text — Telegram auto-linkifies URLs, parse_mode omitted to avoid
  // entity-escaping bugs. ASCII dividers carry the visual structure.
  if (task.status === "completed") {
    const result = cleanText(task.result ?? "(no output)");
    const elapsed = fmtElapsed(task.startedAt, task.completedAt);
    const footerParts = [`orchestrator · via ${task.to}`];
    if (elapsed) footerParts.push(elapsed);
    return `${DIVIDER}\n⚡ Orchestrator\n\n${result || "(empty)"}\n\n— ${footerParts.join(" · ")}\n${DIVIDER}`;
  }
  const err = cleanText(task.error ?? "Unknown error");
  return `${DIVIDER}\n⚡ Orchestrator\n\n❌ Task failed (via ${task.to}): ${err}\n${DIVIDER}`;
}

/**
 * Notify the orchestrator entity that a delegated task has completed or failed.
 *
 * Routing: each entity declares its notifyChannel in nexus.json — "slack",
 * "telegram", or "none". Defaults to "slack" if unset. Channel siloing:
 * Forge-class entities (engineer, advisor) → Slack; content pipeline
 * (writer) → Telegram. Cross-posts are not allowed; on Telegram-channel
 * delivery failure we keep the [already-notified] marker so Orchestrator stays
 * silent rather than fall back to Slack via MCP.
 *
 * Marker semantics: [already-notified] means "user already saw the result
 * via the entity's configured channel". Orchestrator treats it as a hard signal
 * to update its context and not relay anywhere. Absence of the marker
 * means Orchestrator should relay normally (used as fallback when Slack-channel
 * delivery fails so the user still gets notified via Orchestrator's narration).
 */
export async function notifyTaskResult(task: Task): Promise<void> {
  try {
    const nexus = await loadNexus();
    const orchestratorName = nexus.orchestrator;
    const orchestrator = nexus.entities[orchestratorName];
    if (!orchestrator) return;

    const recipient = nexus.entities[task.to] ?? null;
    const channel = resolveChannel(recipient);

    let suppressRelay = false;

    if (channel === "slack") {
      const slackCfg = await getSlackConfig(orchestrator.path);
      if (slackCfg) {
        try {
          await postSlackMessage(slackCfg.token, slackCfg.channelId, buildSlackBody(task));
          suppressRelay = true;
        } catch (err) {
          console.error("[notify] Slack direct post failed:", err);
          // Leave suppressRelay=false so Orchestrator relays via Slack MCP fallback.
        }
      }
    } else if (channel === "telegram") {
      const tgCfg = await getTelegramConfig(orchestrator.path);
      if (tgCfg) {
        try {
          await postTelegramMessage(tgCfg.token, tgCfg.chatId, buildTelegramBody(task));
        } catch (err) {
          console.error("[notify] Telegram direct post failed:", err);
        }
      } else {
        console.error("[notify] Telegram channel selected but no token/chatId in orchestrator settings");
      }
      // Always suppress relay for telegram-routed entities — preserves
      // siloing even on Telegram delivery failure (better to miss a message
      // than cross-post to Slack via Orchestrator's MCP).
      suppressRelay = true;
    } else {
      // channel === "none": entity opted out entirely. Inject for Orchestrator's
      // context but suppress any relay.
      suppressRelay = true;
    }

    const marker = suppressRelay ? " [already-notified]" : "";
    const sessionMsg = task.status === "completed"
      ? `[Delegated task complete — from ${task.to}]${marker}\n${task.result}`
      : `[Delegated task failed — from ${task.to}]${marker}\n${task.error}`;

    await injectIntoOrchestratorSession(nexus.corePath, orchestrator.path, sessionMsg).catch((err) =>
      console.error(`[notify] Session inject failed:`, err)
    );
  } catch (err) {
    console.error("[notify] Failed to send task result notification:", err);
  }
}
