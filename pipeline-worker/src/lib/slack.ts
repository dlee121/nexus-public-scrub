/**
 * Minimal Slack chat.postMessage client for the Forge worker.
 *
 * Why a stand-alone helper rather than @slack/web-api: only one endpoint
 * is needed (chat.postMessage to a single channel), the bot token is
 * already in the worker env, and the package would be the third Slack
 * client across the Nexus monorepo. Keep dependency surface tight.
 *
 * Token: `SLACK_XOXB_TOKEN` is the dedicated bot user (DKAssist app)
 * provisioned for Forge alerts. Earlier code read `SLACK_BOT_TOKEN`,
 * which is Orchestrator's user-scoped xoxp token used by the operator MCP
 * surface — Forge MUST NOT use that. Keep the two cleanly separated.
 *
 * Failure policy: never throw. Slack outages or transient 5xx must not
 * fail a pipeline activity — the work itself succeeded; the operator
 * just doesn't get a ping. We log to stderr and return false so callers
 * can decide whether to surface the miss.
 */

const SLACK_API = 'https://slack.com/api/chat.postMessage';
const TIMEOUT_MS = 5_000;

export interface SlackPostResult {
  ok: boolean;
  ts?: string;
  error?: string;
}

/**
 * Post `text` to `channelId` as the Forge bot (`SLACK_XOXB_TOKEN`).
 *
 * Returns `{ ok: true, ts }` on success, `{ ok: false, error }` on any
 * failure (network, 4xx, slack `ok:false`, missing token). Never throws.
 *
 * `text` accepts Slack mrkdwn — bold with `*`, code with backticks, etc.
 */
export async function postSlackMessage(
  channelId: string,
  text: string,
): Promise<SlackPostResult> {
  const token = process.env.SLACK_XOXB_TOKEN;
  if (!token) {
    process.stderr.write(
      '[slack] SLACK_XOXB_TOKEN not set — skipping notification\n',
    );
    return { ok: false, error: 'SLACK_XOXB_TOKEN unset' };
  }

  try {
    const resp = await fetch(SLACK_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: channelId, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      ts?: string;
      error?: string;
    };

    if (!resp.ok || !data.ok) {
      const errStr = data.error ?? `HTTP ${resp.status}`;
      process.stderr.write(`[slack] post failed: ${errStr}\n`);
      return { ok: false, error: errStr };
    }
    return { ok: true, ts: data.ts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[slack] post threw: ${msg}\n`);
    return { ok: false, error: msg };
  }
}

/**
 * Channel ID for Forge → DK pings. Hard-coded rather than env-configured
 * because there's exactly one alerts channel for Forge and the routing
 * shouldn't be misconfigurable. If the channel ever moves, change this
 * constant in one place.
 *
 * One-way: Forge writes via the DKAssist bot, no inbound signals from
 * this channel. Dashboard remains the source of approval/reject signals
 * (planApprovedSignal, prodApprovedSignal, etc.).
 */
export const FORGE_ALERTS_CHANNEL = '[slack-id]'; // #dk-forge-alerts
