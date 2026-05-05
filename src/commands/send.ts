import { runUserMessage } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig, getSettings } from "../config";
import { relayToSlack } from "../lib/slack-relay";

// Inject sessions (delegated-task-result relays from notify.ts) get a
// short Claude timeout so they can't hold the cross-process session
// lock for the full 30-min default and starve incoming user messages.
// 5 min is generous: Orchestrator's expected behavior on an [already-notified]
// inject is to silently update context (seconds, not minutes). If
// Orchestrator gets stuck, we cap the damage at 5 min of user-message wait.
const INJECT_TIMEOUT_MS = 5 * 60 * 1000;

export async function send(args: string[]) {
  const telegramFlag = args.includes("--telegram");
  const discordFlag = args.includes("--discord");
  // --inject is set by src/notify.ts when delivering a delegated-task
  // result back into Orchestrator's session. Operator CLI invocations
  // (`bun run src/index.ts send "test"`) don't pass it and keep the
  // full 30-min timeout, since DK may legitimately delegate long work.
  const injectFlag = args.includes("--inject");
  const message = args
    .filter((a) => a !== "--telegram" && a !== "--discord" && a !== "--inject")
    .join(" ");

  if (!message) {
    console.error("Usage: nexus send <message> [--telegram] [--discord] [--inject]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const runStart = Date.now();
  const result = await runUserMessage(
    "send",
    message,
    undefined,
    injectFlag ? { timeoutMs: INJECT_TIMEOUT_MS } : undefined,
  );
  const elapsedMs = Date.now() - runStart;
  console.log(result.stdout);

  // Auto-relay Orchestrator's response to Slack. Without this, send-triggered
  // turns (notify.ts injects, runtime continuation prompts, manual
  // `bun run src/index.ts send "..."` invocations) produced output that
  // never reached DK in Slack. Same suppression rules as the inbound
  // path: skip if Orchestrator already posted via MCP (slackPostsMade > 0),
  // skip on [no-relay] tag, post a safe error on raw-JSON output. See
  // src/lib/slack-relay.ts for the full logic.
  const slackCfg = getSettings().slack;
  await relayToSlack(result, elapsedMs, { token: slackCfg.token, channelId: slackCfg.channelId });

  if (telegramFlag) {
    const settings = await loadSettings();
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;

    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of userIds) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text }),
        }
      );
      if (!res.ok) {
        console.error(`Failed to send to Telegram user ${userId}: ${res.statusText}`);
      }
    }
    console.log("Sent to Telegram.");
  }

  if (discordFlag) {
    const settings = await loadSettings();
    const dToken = settings.discord.token;
    const dUserIds = settings.discord.allowedUserIds;

    if (!dToken || dUserIds.length === 0) {
      console.error("Discord is not configured in settings.");
      process.exit(1);
    }

    const dText = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of dUserIds) {
      // Create DM channel
      const dmRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: userId }),
      });
      if (!dmRes.ok) {
        console.error(`Failed to create DM for Discord user ${userId}: ${dmRes.statusText}`);
        continue;
      }
      const { id: channelId } = (await dmRes.json()) as { id: string };
      const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bot ${dToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: dText.slice(0, 2000) }),
      });
      if (!msgRes.ok) {
        console.error(`Failed to send to Discord user ${userId}: ${msgRes.statusText}`);
      }
    }
    console.log("Sent to Discord.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
