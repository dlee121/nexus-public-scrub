import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eventBuffer } from '../state/event-buffer.ts';
import { broadcaster } from '../state/sse-broadcast.ts';
import { terminateWorkflow } from '../state/lifecycle.ts';
import type { ForgeEvent } from '../event-types.ts';

const HEARTBEAT_MS = 30_000;

/**
 * streamRoutes — the SSE GET endpoint, mounted under /api/workflows.
 * Final URL: GET /api/workflows/:id/stream
 *
 * On connect:
 *   1. Subscribe to live events for this workflow (no race window — done
 *      before we read the buffer snapshot, so any event arriving between
 *      the two is delivered via the live channel).
 *   2. Replay the ring buffer (up to 500 events).
 *   3. Tail live events until the client disconnects or the channel closes.
 *
 * SSE event types:
 *   - "forge-event"  → a ForgeEvent payload (data is JSON.stringify'd)
 *   - "snapshot-end" → emitted once after ring-buffer replay completes
 *   - "heartbeat"    → keep-alive every 30s (data is the current ts)
 */
export const streamRoutes = new Hono();

streamRoutes.get('/:id/stream', async (c) => {
  const wfId = c.req.param('id');

  return streamSSE(c, async (stream) => {
    const subscription = broadcaster.subscribe(wfId);
    const snapshot = eventBuffer.get(wfId);

    for (const ev of snapshot) {
      await stream.writeSSE({
        event: 'forge-event',
        data: JSON.stringify(ev),
      });
    }
    await stream.writeSSE({
      event: 'snapshot-end',
      data: JSON.stringify({ replayed: snapshot.length, ts: new Date().toISOString() }),
    });

    let alive = true;
    // Force-terminate the AsyncIterable so the for-await below unblocks
    // even if no more events arrive for this workflow. Without this, a
    // disconnected client would leave the live-tail loop parked on the
    // next subscription.next() forever — a slow zombie-subscriber leak.
    // The broadcaster generator self-cleans its resolver in its own
    // try/finally when .return() fires.
    const releaseSubscription = (): void => {
      void subscription.return?.();
    };

    const heartbeat = (async () => {
      while (alive) {
        await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
        if (!alive) break;
        try {
          await stream.writeSSE({
            event: 'heartbeat',
            data: JSON.stringify({ ts: new Date().toISOString() }),
          });
        } catch {
          alive = false;
          releaseSubscription();
          return;
        }
      }
    })();

    try {
      for await (const ev of subscription) {
        if (!alive) break;
        try {
          await stream.writeSSE({
            event: 'forge-event',
            data: JSON.stringify(ev),
          });
        } catch {
          alive = false;
          break;
        }
      }
    } finally {
      alive = false;
      releaseSubscription();
      await heartbeat.catch(() => {});
    }
  });
});

/**
 * ingestRoutes — internal POST endpoints for worker activities, mounted at
 * the root so the /internal/events path doesn't collide with the workflow
 * router prefix.
 *
 * Auth: requires X-Forge-Token header matching FORGE_EVENT_TOKEN env var.
 *       If FORGE_EVENT_TOKEN is unset, both endpoints return 503 — fail
 *       closed rather than open.
 */
export const ingestRoutes = new Hono();

ingestRoutes.post('/internal/events', async (c) => {
  const expectedToken = process.env.FORGE_EVENT_TOKEN;
  if (!expectedToken || !expectedToken.trim()) {
    return c.json(
      { ok: false, error: 'FORGE_EVENT_TOKEN not configured on console' },
      503,
    );
  }

  const presented = c.req.header('x-forge-token');
  if (presented !== expectedToken) {
    return c.json({ ok: false, error: 'invalid token' }, 401);
  }

  let body: ForgeEvent;
  try {
    body = (await c.req.json()) as ForgeEvent;
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }

  if (!body || typeof body.workflowId !== 'string' || !body.workflowId.trim()) {
    return c.json({ ok: false, error: 'workflowId required' }, 400);
  }
  if (typeof body.kind !== 'string') {
    return c.json({ ok: false, error: 'kind required' }, 400);
  }
  if (typeof body.ts !== 'string') {
    body.ts = new Date().toISOString();
  }

  eventBuffer.push(body);
  broadcaster.publish(body);

  return c.json({ ok: true });
});

/**
 * POST /internal/events/terminal — worker hint that a workflow has reached
 * terminal state. Schedules buffer cleanup and closes any live SSE channels
 * for it. Same auth as /internal/events.
 *
 * This is purely an optimization — buffers will time out organically too.
 */
ingestRoutes.post('/internal/events/terminal', async (c) => {
  const expectedToken = process.env.FORGE_EVENT_TOKEN;
  if (!expectedToken || !expectedToken.trim()) {
    return c.json({ ok: false, error: 'FORGE_EVENT_TOKEN not configured' }, 503);
  }
  if (c.req.header('x-forge-token') !== expectedToken) {
    return c.json({ ok: false, error: 'invalid token' }, 401);
  }

  let body: { workflowId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 400);
  }
  if (!body.workflowId) {
    return c.json({ ok: false, error: 'workflowId required' }, 400);
  }

  terminateWorkflow(body.workflowId);

  return c.json({ ok: true });
});
