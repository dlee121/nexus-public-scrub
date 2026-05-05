/**
 * Forge Console — operator UI for the Forge Temporal pipeline.
 *
 * Run:
 *   bash -c 'source forge-console/load-env.sh && cd forge-console && bun run start'
 *
 * Endpoints:
 *   GET  /                              static HTML SPA
 *   GET  /healthz                       liveness check + buffer/broadcaster stats
 *   GET  /api/workflows                 list workflows (3-bucket)
 *   GET  /api/workflows/:id             workflow detail + plan
 *   POST /api/workflows/:id/approve     send planApprovedSignal
 *   POST /api/workflows/:id/reject      terminate with reason
 *   POST /api/workflows/:id/close       terminate (best-effort cooperative)
 *   GET  /api/workflows/:id/stream      SSE — live event stream for this workflow (v2)
 *   POST /internal/events               event ingestion from worker activities (v2)
 *   POST /internal/events/terminal      worker hint that workflow ended (v2)
 *
 * Binding: 127.0.0.1 by default. Set FORGE_CONSOLE_HOST=0.0.0.0 to bind all
 * interfaces (only do this on EC2 with security-group restrictions in place).
 */

import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { workflowsRoutes } from './routes/workflows.ts';
import { actionsRoutes } from './routes/actions.ts';
import { streamRoutes, ingestRoutes } from './routes/events.ts';
import { eventBuffer } from './state/event-buffer.ts';
import { broadcaster } from './state/sse-broadcast.ts';
import { getNamespace } from './temporal.ts';

const PORT = Number(process.env.FORGE_CONSOLE_PORT ?? 4640);
const HOST = process.env.FORGE_CONSOLE_HOST ?? '127.0.0.1';

const app = new Hono();

app.use('*', honoLogger());

// Host-header check. When bound to localhost AND no API token is configured,
// the daemon is in legacy local-only mode — refuse non-loopback Host
// headers (DNS-rebinding defense). Once FORGE_API_TOKEN is configured,
// we're explicitly fronted by cloudflared; the token is the auth and the
// Host check moves out of the way.
app.use('*', async (c, next) => {
  const isLocalhostBind = HOST === '127.0.0.1' || HOST === 'localhost';
  const apiTokenConfigured = !!process.env.FORGE_API_TOKEN;
  if (isLocalhostBind && !apiTokenConfigured) {
    const host = c.req.header('host') ?? '';
    const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
    if (!allowed.includes(host)) {
      return c.text(`Host '${host}' not allowed; expected one of ${allowed.join(', ')}`, 403);
    }
  }
  await next();
});

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    namespace: getNamespace(),
    binding: `${HOST}:${PORT}`,
    ts: new Date().toISOString(),
    streaming: {
      ingestEnabled: !!process.env.FORGE_EVENT_TOKEN,
      buffer: eventBuffer.stats(),
      broadcaster: broadcaster.stats(),
    },
    apiAuth: {
      enabled: !!process.env.FORGE_API_TOKEN,
    },
  }),
);

// /api/* token gate. Until now /api/* relied on localhost binding for security
// (no auth header required). With cloudflared exposing the daemon at
// forge.[company-domain], we need an app-layer check too. Behavior:
//   - If FORGE_API_TOKEN is unset and we're bound to localhost, skip the
//     gate (preserves the local-dev / SSH-tunnel ergonomics).
//   - If FORGE_API_TOKEN is set, require it on every /api/* request via
//     X-Forge-Token header. The SSE route accepts ?api_token= as a fallback
//     because browser EventSource can't send custom headers; the proxy in
//     [target-repo-web] already strips bearers from upstream URLs, so this token
//     query never reaches anywhere downstream.
//   - If FORGE_API_TOKEN is set BUT bound to 127.0.0.1 AND the request comes
//     from a same-host loopback Host header, skip the gate (local dev).
const apiToken = process.env.FORGE_API_TOKEN ?? '';
app.use('/api/*', async (c, next) => {
  const isLocalhostBind = HOST === '127.0.0.1' || HOST === 'localhost';
  const isLocalhostHost = (c.req.header('host') ?? '').match(
    new RegExp(`^(127\\.0\\.0\\.1|localhost):${PORT}$`),
  );
  if (!apiToken && isLocalhostBind) {
    // No token configured + localhost bind: trust the binding. Same posture
    // as v1 / v2 / v3 of the console pre-public-exposure.
    return next();
  }
  if (apiToken && isLocalhostBind && isLocalhostHost) {
    // Token configured but request is loopback — skip the gate. Lets the
    // operator hit the dashboard via SSH tunnel without juggling the token.
    return next();
  }
  if (!apiToken) {
    return c.json({ ok: false, error: 'FORGE_API_TOKEN not configured' }, 503);
  }
  const header = c.req.header('x-forge-token');
  const queryParam = c.req.query('api_token');
  const presented = header || queryParam || '';
  if (presented !== apiToken) {
    return c.json({ ok: false, error: 'invalid token' }, 401);
  }
  await next();
});

app.route('/api/workflows', workflowsRoutes);
app.route('/api/workflows', actionsRoutes);
app.route('/api/workflows', streamRoutes);   // GET /api/workflows/:id/stream (SSE)
app.route('/', ingestRoutes);                // POST /internal/events, /internal/events/terminal

// Periodic sweep — drops buffers whose terminal-grace deadline has passed.
const sweepInterval = setInterval(() => eventBuffer.sweep(), 60_000);
// Don't keep the process alive on the sweep alone (Bun honors unref).
if (typeof sweepInterval.unref === 'function') sweepInterval.unref();

// Static index.html — read once at startup; small file, no need for re-read.
const indexHtml = await Bun.file(new URL('./ui/index.html', import.meta.url)).text();
app.get('/', (c) => c.html(indexHtml));

// Serve any other GET that doesn't match an /api/ route as the SPA shell.
// (We don't currently need client-side routing, but this future-proofs
// /workflow/:id deep-linking when v2 adds it.)
app.notFound((c) => {
  if (c.req.method === 'GET' && !c.req.path.startsWith('/api/')) {
    return c.html(indexHtml);
  }
  return c.text('Not found', 404);
});

console.log(`[forge-console] listening on http://${HOST}:${PORT}`);
console.log(`[forge-console] namespace: ${getNamespace()}`);

export default {
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
};
