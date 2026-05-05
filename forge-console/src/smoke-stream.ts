/**
 * smoke-stream.ts — exercises the v2 streaming path end-to-end against a
 * locally-running console:
 *
 *   1. POSTs synthetic events to /internal/events with a valid token
 *   2. Opens an SSE connection to /api/workflows/:id/stream
 *   3. Asserts replay returns the events we posted
 *   4. Posts ONE more event and asserts it arrives via the live channel
 *
 * Does NOT spawn a console; assumes one is already running on
 * FORGE_CONSOLE_URL with FORGE_EVENT_TOKEN configured.
 *
 * Usage (from the forge-console directory, with env loaded):
 *   bash -c 'source load-env.sh && bun run smoke-stream'
 *
 * If the console isn't running, start it in another shell first:
 *   bash -c 'source load-env.sh && bun run start'
 */

const url = process.env.FORGE_CONSOLE_URL ?? 'http://127.0.0.1:4640';
const token = process.env.FORGE_EVENT_TOKEN;
if (!token) {
  console.error('[smoke-stream] FORGE_EVENT_TOKEN must be set in env');
  process.exit(1);
}

const wfId = `smoke-stream-${Date.now()}`;
console.log(`[smoke-stream] using workflow id: ${wfId}`);
console.log(`[smoke-stream] target: ${url}`);

async function postEvent(idx: number, kind = 'assistant'): Promise<void> {
  const res = await fetch(`${url}/internal/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forge-Token': token!,
      Host: 'localhost:4640',
    },
    body: JSON.stringify({
      workflowId: wfId,
      kind,
      ts: new Date().toISOString(),
      payload: {
        type: kind,
        message: { content: [{ type: 'text', text: `synthetic event ${idx}` }] },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /internal/events failed: ${res.status} ${body}`);
  }
}

// Step 1: post 3 events first so the ring buffer has content to replay.
console.log('[smoke-stream] posting 3 events to ring buffer…');
for (let i = 1; i <= 3; i++) await postEvent(i);
console.log('[smoke-stream] ✓ ingest accepted 3 events');

// Step 2: open SSE stream and collect events for ~2s.
console.log('[smoke-stream] opening SSE stream and collecting…');
const controller = new AbortController();
setTimeout(() => controller.abort(), 3000);

const sseRes = await fetch(`${url}/api/workflows/${wfId}/stream`, {
  headers: { Accept: 'text/event-stream', Host: 'localhost:4640' },
  signal: controller.signal,
});
if (!sseRes.ok || !sseRes.body) {
  throw new Error(`SSE GET failed: ${sseRes.status}`);
}

const collected: { event: string; data: string }[] = [];
const reader = sseRes.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let livePosted = false;

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE frames: blank-line-separated, each frame has event: + data: lines.
    let split: number;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const event = (frame.match(/^event: (.+)$/m) ?? [])[1] ?? 'message';
      const data = (frame.match(/^data: (.+)$/m) ?? [])[1] ?? '';
      collected.push({ event, data });
    }

    // Once we've seen snapshot-end, post a fresh event to test the live channel.
    if (!livePosted && collected.some((f) => f.event === 'snapshot-end')) {
      livePosted = true;
      console.log('[smoke-stream] snapshot-end seen, posting live event…');
      await postEvent(99, 'live-test');
    }
  }
} catch (err) {
  // AbortError is expected — we cap the test at 3s.
  const msg = err instanceof Error ? err.message : String(err);
  if (!/abort/i.test(msg)) throw err;
}

console.log(`[smoke-stream] collected ${collected.length} SSE frames`);

const replayed = collected.filter((f) => f.event === 'forge-event' && JSON.parse(f.data).workflowId === wfId);
const snapshotEnd = collected.find((f) => f.event === 'snapshot-end');
const liveEvent = collected
  .filter((f) => f.event === 'forge-event')
  .map((f) => JSON.parse(f.data))
  .find((e) => e.kind === 'live-test');

const errors: string[] = [];
if (replayed.length < 3) errors.push(`expected ≥3 forge-events from replay, got ${replayed.length}`);
if (!snapshotEnd) errors.push('snapshot-end frame missing');
if (!liveEvent) errors.push('live-test event not received via live channel');

if (errors.length > 0) {
  console.error('[smoke-stream] FAILED:');
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}

console.log('[smoke-stream] ✓ replay returned ≥3 events');
console.log('[smoke-stream] ✓ snapshot-end frame present');
console.log('[smoke-stream] ✓ live event flowed through broadcaster');
console.log('[smoke-stream] all checks passed.');
process.exit(0);

// Make this file a module so top-level await is allowed under tsc.
export {};
