import { FORGE_ALERTS_CHANNEL, postSlackMessage } from '../lib/slack';

/**
 * Temporal-activity wrapper around the Slack post helper.
 *
 * Activities are the only place worker code can do non-deterministic
 * I/O — workflows can't fetch directly. Wrapping the post in an
 * activity also means it inherits Temporal's retry policy, so a
 * transient Slack 5xx gets retried automatically.
 *
 * Activity is failure-tolerant by design: on persistent failure we
 * log via `postSlackMessage` and return `{ ok: false }`. Workflow
 * code should NOT throw on a Slack-post failure — the pipeline work
 * already succeeded; missing a ping is observability, not correctness.
 */
export async function notifySlackActivity(params: {
  /** Channel id. Defaults to #dk-forge-alerts. */
  channelId?: string;
  /** Slack mrkdwn body. */
  text: string;
}): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const channel = params.channelId ?? FORGE_ALERTS_CHANNEL;
  return await postSlackMessage(channel, params.text);
}
