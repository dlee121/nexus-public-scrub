import type { ForgeEvent } from './event-types';

/**
 * Best-effort event emission to forge-console. NEVER throws — all failures
 * are swallowed (logged to stderr) because event emission is observability,
 * not correctness, and a dead console must never kill an in-flight activity.
 *
 * Configuration:
 *   FORGE_CONSOLE_URL    base URL of the console (e.g. http://127.0.0.1:4640).
 *                        If unset, this function is a silent no-op — emission
 *                        is opt-in via env, so default behavior is unchanged.
 *   FORGE_EVENT_TOKEN    shared secret for /internal/events. Required when
 *                        FORGE_CONSOLE_URL is set; without it we don't bother
 *                        sending the request (would be 401'd anyway).
 *
 * Timeout: 2s per request. Failed POSTs are dropped, not retried — events
 * are time-sensitive observability, not durable record. The durable record
 * lives in the workflow's stream-json output (still buffered by cc.ts).
 */

const TIMEOUT_MS = 2_000;

interface EmitterConfig {
  url: string;
  token: string;
}

function resolveConfig(): EmitterConfig | null {
  const url = process.env.FORGE_CONSOLE_URL;
  const token = process.env.FORGE_EVENT_TOKEN;
  if (!url || !url.trim() || !token || !token.trim()) return null;
  // Trim trailing slash so concatenation doesn't double up.
  const cleanUrl = url.replace(/\/+$/, '');
  return { url: cleanUrl, token };
}

export async function emitEvent(event: ForgeEvent): Promise<void> {
  const cfg = resolveConfig();
  if (!cfg) return;

  try {
    await fetch(`${cfg.url}/internal/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forge-Token': cfg.token,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Don't inspect status — even 4xx/5xx is a non-fatal observability
    // failure. The activity continues regardless.
  } catch (err) {
    // Best-effort: log to stderr so journald captures it on EC2, but don't
    // propagate. console.error returns void; we're done.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[event-emit] dropped event for ${event.workflowId}: ${msg}\n`);
  }
}

export async function emitTerminal(workflowId: string): Promise<void> {
  const cfg = resolveConfig();
  if (!cfg) return;
  try {
    await fetch(`${cfg.url}/internal/events/terminal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forge-Token': cfg.token,
      },
      body: JSON.stringify({ workflowId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[event-emit] terminal hint dropped for ${workflowId}: ${msg}\n`);
  }
}
