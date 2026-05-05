import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { getTemporalClient } from '../temporal-client';
import type { PipelineState } from '../types';

const DASHBOARD_HOST = '127.0.0.1';
const DASHBOARD_PORT = 4640;
const TASK_QUEUE = 'forge-pipeline';

interface WorkflowCard {
  workflowId: string;
  state: string;
  ticketId: string;
}

interface WorkflowsResponse {
  needsApproval: WorkflowCard[];
  running: WorkflowCard[];
  done: WorkflowCard[];
}

// Application-level state buckets.
// Any state not listed in NEEDS_APPROVAL_STATES or DONE_STATES falls into "running".
const NEEDS_APPROVAL_STATES: ReadonlySet<string> = new Set<PipelineState>([
  'PLANNING',
  'PLAN_REVIEW',
  'APPROVAL_WAIT',
]);

const DONE_STATES: ReadonlySet<string> = new Set<PipelineState>([
  'DONE',
  'BLOCKED',
  'FAILED',
]);

// Temporal execution statuses that we treat as "done" when no app-level state is available.
const TEMPORAL_DONE_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
]);

function extractTicketId(workflowId: string): string {
  // Workflow IDs follow the convention `pipeline-<ticketId>` for child
  // workflows, plus fixed IDs like `patrol-agent` or `deploy-coordinator-<env>`.
  if (workflowId.startsWith('pipeline-')) {
    return workflowId.slice('pipeline-'.length);
  }
  return workflowId;
}

function classifyState(state: string): 'needsApproval' | 'running' | 'done' {
  if (NEEDS_APPROVAL_STATES.has(state)) return 'needsApproval';
  if (DONE_STATES.has(state)) return 'done';
  if (TEMPORAL_DONE_STATUSES.has(state)) return 'done';
  return 'running';
}

async function listActiveWorkflows(): Promise<WorkflowsResponse> {
  const client = await getTemporalClient();
  const response: WorkflowsResponse = {
    needsApproval: [],
    running: [],
    done: [],
  };

  const query = `TaskQueue="${TASK_QUEUE}"`;

  for await (const execution of client.workflow.list({ query })) {
    const workflowId = execution.workflowId;
    const ticketId = extractTicketId(workflowId);

    // Prefer the app-level `currentStateQuery` from PipelineWorkflow; fall back
    // to the Temporal execution status name if the query isn't supported
    // (e.g. patrol / coordinator / multi-ticket workflows) or the workflow is
    // already closed.
    let state: string = execution.status.name;
    if (execution.status.name === 'RUNNING') {
      try {
        const handle = client.workflow.getHandle(workflowId);
        const queried = await handle.query<PipelineState>('currentStateQuery');
        state = queried;
      } catch {
        // No handler for currentStateQuery on this workflow type, or it is
        // closed/terminated between list and query — keep the Temporal status.
      }
    }

    const card: WorkflowCard = { workflowId, state, ticketId };
    const bucket = classifyState(state);
    response[bucket].push(card);
  }

  return response;
}

async function signalWorkflow(workflowId: string, signalName: string): Promise<void> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(signalName);
}

async function closeWorkflow(workflowId: string): Promise<void> {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  // Best-effort signal — the workflow may ignore it if no handler is registered.
  try {
    await handle.signal('closeWorkflowSignal');
  } catch {
    // Ignore — we'll terminate below regardless.
  }
  try {
    await handle.terminate('Closed via approval dashboard');
  } catch (err) {
    // Already closed is not a problem.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not found|already completed|closed/i.test(msg)) {
      throw err;
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html).toString(),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Forge — Approval Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #14181d;
      --panel-border: #232a31;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --approve: #238636;
      --approve-hover: #2ea043;
      --danger: #da3633;
      --danger-hover: #f85149;
      --needs: #d29922;
      --running: #58a6ff;
      --done: #7d8590;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    header h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }
    #last-refresh {
      color: var(--muted);
      font-size: 12px;
    }
    .sections {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--panel-border);
      border-radius: 8px;
      padding: 16px;
    }
    section h2 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }
    section.needs-approval h2 { color: var(--needs); }
    section.running h2 { color: var(--running); }
    section.done h2 { color: var(--done); }
    .card {
      background: #0e1217;
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .card:last-child { margin-bottom: 0; }
    .card .wid {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--text);
      word-break: break-all;
    }
    .card .meta {
      margin-top: 4px;
      font-size: 11px;
      color: var(--muted);
    }
    .card .state {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      background: #1f2933;
      color: var(--accent);
      margin-top: 6px;
    }
    .actions {
      margin-top: 10px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid transparent;
      cursor: pointer;
      color: #fff;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.approve { background: var(--approve); }
    button.approve:hover:not(:disabled) { background: var(--approve-hover); }
    button.danger { background: var(--danger); }
    button.danger:hover:not(:disabled) { background: var(--danger-hover); }
    button.neutral { background: #30363d; }
    button.neutral:hover:not(:disabled) { background: #3a4049; }
    .interrupt {
      margin-top: 10px;
      display: flex;
      gap: 6px;
    }
    .interrupt input {
      flex: 1;
      background: #0b0d10;
      color: var(--text);
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
    }
    .empty {
      color: var(--muted);
      font-size: 12px;
      font-style: italic;
    }
    .error {
      background: #5a1d1d;
      border: 1px solid var(--danger);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
      font-size: 13px;
      color: #fdd;
    }
    .error.hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <h1>Forge — Approval Dashboard</h1>
    <span id="last-refresh">Loading…</span>
  </header>

  <div id="error" class="error hidden"></div>

  <div class="sections">
    <section class="needs-approval">
      <h2>Needs Approval</h2>
      <div id="needsApproval"></div>
    </section>
    <section class="running">
      <h2>Running</h2>
      <div id="running"></div>
    </section>
    <section class="done">
      <h2>Done</h2>
      <div id="done"></div>
    </section>
  </div>

  <script>
    const errEl = document.getElementById('error');
    const lastRefreshEl = document.getElementById('last-refresh');

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function actionsFor(bucket, workflowId) {
      const encoded = encodeURIComponent(workflowId);
      const closeBtn = '<button class="danger" data-action="close" data-wid="' + escapeHtml(encoded) + '">Close</button>';
      if (bucket === 'needsApproval') {
        return (
          '<button class="approve" data-action="approve-plan" data-wid="' + escapeHtml(encoded) + '">Approve plan</button>' +
          '<button class="approve" data-action="approve-prod-deploy" data-wid="' + escapeHtml(encoded) + '">Approve prod deploy</button>' +
          closeBtn
        );
      }
      if (bucket === 'running') {
        return (
          '<button class="approve" data-action="approve-prod-deploy" data-wid="' + escapeHtml(encoded) + '">Approve prod deploy</button>' +
          closeBtn
        );
      }
      return closeBtn;
    }

    function renderCard(bucket, card) {
      return (
        '<div class="card">' +
          '<div class="wid">' + escapeHtml(card.workflowId) + '</div>' +
          '<div class="meta">ticket: ' + escapeHtml(card.ticketId) + '</div>' +
          '<span class="state">' + escapeHtml(card.state) + '</span>' +
          '<div class="actions">' + actionsFor(bucket, card.workflowId) + '</div>' +
          '<div class="interrupt">' +
            '<input type="text" disabled placeholder="Send interrupt (coming soon)" />' +
            '<button class="neutral" disabled>Send</button>' +
          '</div>' +
        '</div>'
      );
    }

    function renderBucket(id, bucket, items) {
      const el = document.getElementById(id);
      if (!items || items.length === 0) {
        el.innerHTML = '<div class="empty">None</div>';
        return;
      }
      el.innerHTML = items.map(function (c) { return renderCard(bucket, c); }).join('');
    }

    async function refresh() {
      try {
        const res = await fetch('/api/workflows');
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        renderBucket('needsApproval', 'needsApproval', data.needsApproval || []);
        renderBucket('running', 'running', data.running || []);
        renderBucket('done', 'done', data.done || []);
        errEl.classList.add('hidden');
        lastRefreshEl.textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
      } catch (e) {
        errEl.textContent = 'Failed to load workflows: ' + (e && e.message ? e.message : e);
        errEl.classList.remove('hidden');
      }
    }

    async function handleAction(ev) {
      const btn = ev.target.closest('button[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.getAttribute('data-action');
      const wid = btn.getAttribute('data-wid');
      btn.disabled = true;
      try {
        const res = await fetch('/api/' + action + '/' + wid, { method: 'POST' });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || ('status ' + res.status));
        }
        await refresh();
      } catch (e) {
        errEl.textContent = 'Action ' + action + ' failed: ' + (e && e.message ? e.message : e);
        errEl.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    }

    document.addEventListener('click', handleAction);
    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>
`;

interface RouteMatch {
  type: 'root' | 'list' | 'approve-plan' | 'approve-prod-deploy' | 'close' | 'none';
  workflowId?: string;
}

function matchRoute(method: string, pathname: string): RouteMatch {
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return { type: 'root' };
  }
  if (method === 'GET' && pathname === '/api/workflows') {
    return { type: 'list' };
  }
  if (method === 'POST') {
    const approvePlan = /^\/api\/approve-plan\/(.+)$/.exec(pathname);
    if (approvePlan) {
      return { type: 'approve-plan', workflowId: decodeURIComponent(approvePlan[1]) };
    }
    const approveProd = /^\/api\/approve-prod-deploy\/(.+)$/.exec(pathname);
    if (approveProd) {
      return { type: 'approve-prod-deploy', workflowId: decodeURIComponent(approveProd[1]) };
    }
    const close = /^\/api\/close\/(.+)$/.exec(pathname);
    if (close) {
      return { type: 'close', workflowId: decodeURIComponent(close[1]) };
    }
  }
  return { type: 'none' };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? `${DASHBOARD_HOST}:${DASHBOARD_PORT}`;
  const url = new URL(req.url ?? '/', `http://${host}`);
  const route = matchRoute(method, url.pathname);

  try {
    switch (route.type) {
      case 'root':
        sendHtml(res, 200, DASHBOARD_HTML);
        return;

      case 'list': {
        const data = await listActiveWorkflows();
        sendJson(res, 200, data);
        return;
      }

      case 'approve-plan': {
        if (!route.workflowId) {
          sendText(res, 400, 'workflowId required');
          return;
        }
        await signalWorkflow(route.workflowId, 'planApprovedSignal');
        sendJson(res, 200, { ok: true, workflowId: route.workflowId, signal: 'planApprovedSignal' });
        return;
      }

      case 'approve-prod-deploy': {
        if (!route.workflowId) {
          sendText(res, 400, 'workflowId required');
          return;
        }
        await signalWorkflow(route.workflowId, 'prodDeployApprovedSignal');
        sendJson(res, 200, { ok: true, workflowId: route.workflowId, signal: 'prodDeployApprovedSignal' });
        return;
      }

      case 'close': {
        if (!route.workflowId) {
          sendText(res, 400, 'workflowId required');
          return;
        }
        await closeWorkflow(route.workflowId);
        sendJson(res, 200, { ok: true, workflowId: route.workflowId, action: 'closed' });
        return;
      }

      case 'none':
      default:
        sendText(res, 404, 'Not found');
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[dashboard]', method, url.pathname, 'error:', msg);
    sendJson(res, 500, { ok: false, error: msg });
  }
}

export async function startDashboard(): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[dashboard] unhandled request error:', msg);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: msg });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
      server.off('error', onError);
      // eslint-disable-next-line no-console
      console.log(`[dashboard] listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
      resolve();
    });
  });
}
