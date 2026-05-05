# Forge Console — Design Proposal v1

**Status:** draft · awaiting review
**Author:** Engineer (delegated by Orchestrator)
**Date:** 2026-04-25
**Scope:** v1 (approval UI, ship now) + design for v2 (live stream) + v3 (prompt injection)

---

## TL;DR

Build a small Bun + Hono web service at `forge-console/` (sibling package to `pipeline-worker/`) that operates as a thin client of Temporal Cloud. **v1** replaces `approve.ts` with a clickable browser UI listing waiting workflows and showing each plan inline. **v2** layers per-workflow live-event streaming on top by tapping `claude -p`'s existing `stream-json` output and pushing events through a console-side SSE channel. **v3** adds operator prompt injection via a new `injectPromptSignal` on `pipelineWorkflow`, drained by activities at safe boundaries (between phases initially; within-phase requires a `cc.ts` refactor to interactive sessions).

The console's foundations support all three from day one. v1 ships as a feature branch PR; v2 and v3 are documented but not built yet.

---

## Background

### What exists today

- **`pipeline-worker/src/cli/approve.ts`** — single CLI, sends `planApprovedSignal` via `client.workflow.getHandle(id).signal()`. Operator interface for plan approval. Works against Temporal Cloud; works against EC2 worker because the signal lands on Temporal and the worker picks it up.
- **`pipeline-worker/src/cli/list.ts`** — lists running workflows on `forge-pipeline` task queue.
- **`pipeline-worker/src/cli/e2e-probe.ts`** — triggers a workflow with a known cleanup payload and asserts RUNNING. Recently added; example of the trigger pattern.
- **`pipeline-worker/src/dashboard/server.ts`** — 16KB Node `http` server on `127.0.0.1:4640`. Already implements: `GET /api/workflows` (3-bucket: needsApproval / running / done), `POST /api/approve-plan/:id`, `POST /api/approve-prod-deploy/:id`, `POST /api/close/:id`, vanilla dark-mode HTML with auto-refresh. Exports `startDashboard()` async function. **Not wired into `worker.ts` startup** — the function exists but nothing calls it. Can be revived as v1 OR superseded by a fresh Bun + Hono build.
- **`pipeline-worker/src/lib/cc.ts`** — invokes `claude -p <msg> --output-format stream-json`. Stream-json output is buffered into a string and returned to the workflow as the activity result. **The structured event stream is already being produced — it's just being thrown away after buffering.** This is the hook v2 streaming hangs off.
- **Workflow signals on `pipelineWorkflow`** — `dangerApprovedSignal`, `dangerRejectedSignal`, `coveredByCoalesceSignal`, `deployCompletedSignal`. Plus `currentStateQuery` → `PipelineState`. **No injection signal exists yet.** v3 adds one.
- **Workflow signal on `multiTicketWorkflow`** — `planApprovedSignal` only. The plan-review gate.

### What's missing

1. No browser UI. Approval requires shell access to wherever Temporal certs live, plus knowing the right `node dist/cli/approve.js <id>` invocation.
2. No plan visibility for the reviewer — `approve.ts` doesn't show what they're approving. The operator has to inspect the plan via `temporal workflow show` or trust the trigger output they invoked themselves.
3. No live view of what Claude Code is doing inside an active activity. The full `stream-json` is captured as activity output (visible after activity completes); during the run, the operator is blind.
4. No way to steer a running pipeline. Once approved, the operator can only close/terminate or wait.

This proposal addresses (1) and (2) in v1, (3) in v2, (4) in v3.

### Constraints (verbatim from the brief)

- Bun runtime everywhere (caveat: pipeline-worker is Node; the console will be Bun).
- Channel siloing: Forge → Slack only. No Telegram for Forge.
- Orchestrator owns no code; Engineer owns all of it.
- Same monorepo. New package or subdir of `pipeline-worker/` — implementer's call.
- Auth: operator-only, no public exposure. Localhost / Tailscale fine.
- Must work end-to-end with the EC2 worker. Console must NOT assume the worker is local.

---

## Goals & Non-Goals

### Goals

1. **v1**: A browser UI an operator can hit to approve plans. Shows the plan content. One click to approve. Replaces `approve.ts` as the primary path (CLI stays as scriptable fallback).
2. **v2 (designed, not built)**: Live event view of running workflows. Operator can open `/workflow/<id>` and watch CC's tool calls, file edits, assistant turns scroll by.
3. **v3 (designed, not built)**: Operator can type a prompt into the live view; it lands as a steer in CC's next turn within the running pipeline.
4. **Foundations support v2/v3 from day one** — directory layout, env handling, deployment story chosen so the v2/v3 additions are layered, not redesigned.

### Non-goals

- Multi-operator concurrent editing. Single operator at a time is fine for now.
- Multi-tenant auth. Localhost / SSH-tunnel / Tailscale-bound is sufficient for an internal tool.
- Mobile-friendly UI. Desktop browser is the target.
- Replaying historical runs. Read live or read post-mortem via Temporal Cloud UI; replays are an explicit non-goal.
- Public-internet exposure. If anyone needs remote access, SSH-tunnel or Tailscale.
- Persistent storage of stream events past a workflow's lifetime. Activities already write durable logs to disk under `pipeline-worker/logs/`; the console's job is live observation, not durable archive.

---

## Architecture

### Where it lives

**Decision: new sibling package `forge-console/` at the repo root.**

Considered: `pipeline-worker/src/console/` (subdirectory). Rejected because:

- The console is a Bun process; the worker is Node. Mixing runtimes inside one package's `package.json` invites pain (which `node_modules` resolution wins for `@temporalio/client`?).
- The console's deps (Hono, an SSE library) shouldn't bloat the worker's container image.
- Forge console will likely grow features unrelated to the worker (Slack alert dispatch, metrics, etc.) — earlier separation reduces refactor cost later.

The console will reuse Temporal client construction logic (mTLS connection setup) by **copying the connection block from `pipeline-worker/src/temporal-client.ts`** into a small `forge-console/src/temporal.ts`. Duplication is ~15 lines; cross-package imports in a non-monorepo are messier than that.

If/when this codebase formalizes a Bun monorepo with workspaces, the duplication can be lifted to a shared `forge-shared/` package.

### Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Bun ≥1.1 | Brief specifies Bun; already used by `bun run src/smoke/run-all.ts` etc. |
| HTTP framework | Hono | ~6KB, runs natively on Bun, ergonomic routing, first-class SSE support, no external deps. Alternative considered: hand-rolled `Bun.serve()` like `dashboard/server.ts` does with Node `http`. Hono wins on routing clarity once we add 6+ endpoints in v2/v3. |
| Frontend | Vanilla HTML + JS, no bundler, no framework | Existing `dashboard/server.ts` does vanilla; 250 lines of HTML/JS handle approve + auto-refresh fine. Adding React/Vue/Svelte for what's effectively a CRUD list + an event tail is over-engineering. SSE is built into browsers. |
| State | In-memory ring buffers, per-workflow | Live events keyed by `workflowId`, ring-buffered to last N (default 1000) events per active workflow, evicted when workflow reaches terminal state. No DB. |
| Auth (v1) | Bind `127.0.0.1:4640` (no LAN exposure). Operator runs on Mac OR via SSH tunnel from Mac to EC2-deployed console. | Matches existing `dashboard/server.ts` model. Zero infrastructure. |
| Auth (v3) | Add a single shared-secret header (`X-Forge-Token: <token>`) sourced from `.pipeline-secrets.env` for write endpoints (approve, inject, terminate). UI prompts once on first load, stashes in `localStorage`. | v3 introduces irreversible operator actions; basic shared-secret prevents accidental requests via DNS rebinding etc. Localhost binding is the primary defense; the token is belt-and-suspenders. |
| Deployment | Two profiles: **dev (operator's Mac)** for development; **prod (EC2 worker host)** as a systemd unit alongside `forge-worker.service`. Operator SSH-tunnels port 4640 from Mac to EC2 to use it. | Matches the brief's "must work end-to-end with EC2 worker" — when running on EC2, the console can receive activity events from the worker via localhost (v2). |

### Why Bun + Hono specifically

- Bun's `Bun.serve()` is fast and modern but its routing is bare metal. Hono adds a Express-compatible-ish router with ~6KB overhead. At v3, we'll have ~12 routes; hand-rolling them is pain.
- Hono's SSE helper is one line: `c.streamSSE(...)`. Doing SSE on raw `Bun.serve()` requires manually managing `ReadableStream` controllers. Worth the dep.
- Hono has zero transitive deps. Adds essentially no build-time cost.

### Process model

**v1**: console runs as a single process. Receives HTTP requests, opens a single shared `Client` to Temporal Cloud (lazy-init), serves API + HTML.

**v2**: same single process, plus an internal HTTP listener on `/internal/events` (POST) that ingests events from worker activities. Same port, internal route guarded by binding (only worker on same host can reach `127.0.0.1:4640`).

**v3**: same shape; adds a `POST /api/workflows/:id/inject` route that signals the workflow.

No worker pool, no queue, no persistence layer. If the console process dies, in-flight events are lost; the persistent record lives in the worker's `logs/` and Temporal's history.

### Deployment

```
forge-console/
├── package.json                 # bun + hono dep
├── tsconfig.json
├── src/
│   ├── server.ts                # Hono app + Bun.serve()
│   ├── temporal.ts              # Temporal client (mTLS connect)
│   ├── routes/
│   │   ├── workflows.ts         # GET /api/workflows, GET /api/workflows/:id
│   │   ├── approve.ts           # POST /api/workflows/:id/approve, /reject, /close
│   │   ├── events.ts            # GET /api/workflows/:id/events (SSE) — v2
│   │   ├── inject.ts            # POST /api/workflows/:id/inject — v3
│   │   └── ingest.ts            # POST /internal/events — v2 (worker → console)
│   ├── state/
│   │   └── ring.ts              # per-workflow ring buffer (v2)
│   └── ui/
│       └── index.html           # vanilla SPA
└── load-env.sh                  # symlink or copy of pipeline-worker/load-env.sh
```

`forge-console.service` systemd unit (when deployed to EC2):

```ini
[Unit]
Description=Forge Console (operator UI)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/nexus/core/forge-console
EnvironmentFile=/run/forge-worker.env
ExecStart=/usr/bin/bun run src/server.ts
Restart=on-failure
```

`/run/forge-worker.env` already exists for the worker; reuse it for the console.

---

## v1 — Approval UI (this PR)

### API surface

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/` | — | Static HTML shell |
| GET | `/api/workflows` | — | List workflows on `forge-pipeline`. Returns 3 buckets keyed by app-level state. |
| GET | `/api/workflows/:id` | — | Workflow detail: status, ticketId, plan content (queried via `currentPlanQuery` if defined; falls back to history scrape), child workflow IDs. |
| POST | `/api/workflows/:id/approve` | — | `signal(planApprovedSignal)` |
| POST | `/api/workflows/:id/reject` | `{reason?}` | Best-effort: signal `closeWorkflowSignal` then `terminate("Rejected via console: <reason>")`. Note: pipelineWorkflow has no `planRejectedSignal` today. **Reject = terminate** in v1; if true reject-and-rewind is wanted later, that's a workflow design change (define `planRejectedSignal`, decide semantics — re-plan? mark FAILED? compensation?). Flagged as open question. |
| POST | `/api/workflows/:id/close` | — | Same as existing dashboard's close. Best-effort signal then terminate. |

All write endpoints respond `200 {ok: true, workflowId, signal}` on success, `4xx/5xx {ok: false, error}` on failure.

### Plan visibility

**Critical UX requirement: the operator must see what they're approving.**

Two options for fetching plan content:

**Option A (preferred): add `currentPlanQuery` to `multiTicketWorkflow`.** Workflow stashes `wavePlan` in module state, `currentPlanQuery` returns it. Console queries via `client.workflow.getHandle(id).query('currentPlanQuery')`. Live, always accurate.

```typescript
// in MultiTicketWorkflow.ts, additive:
import { defineQuery } from '@temporalio/workflow';
export const currentPlanQuery = defineQuery<WavePlan | null>('currentPlanQuery');

export async function multiTicketWorkflow(wavePlan: WavePlan): Promise<void> {
  setHandler(currentPlanQuery, () => wavePlan);
  // ... existing body unchanged ...
}
```

This is a 3-line change in the workflow. Adding a new query handler is safe for in-flight workflows (older workflows just won't respond to it; the console catches the rejection and falls back to option B).

**Option B (fallback): scrape from workflow history.** When trigger.ts starts a workflow, the `wavePlan` is the first arg, captured in the `WorkflowExecutionStartedEventAttributes.input`. Read via `client.workflow.getHandle(id).fetchHistory()`. Slower (~200ms vs <50ms for a query) but works even on workflows that haven't been re-deployed.

**Decision: implement A as the workflow change in this PR. Implement B in the console as the fallback for in-flight pre-deploy workflows.**

### Frontend (sketch)

```html
<!doctype html>
<html>
  <head>
    <title>Forge Console</title>
    <style>/* dark theme, monospace IDs, GH-ish accents — based on existing dashboard */</style>
  </head>
  <body>
    <header>
      <h1>Forge Console</h1>
      <span id="last-refresh"></span>
    </header>
    <main>
      <section class="needs-approval">
        <h2>Awaiting Plan Approval</h2>
        <div id="needsApproval"></div>
      </section>
      <section class="running">
        <h2>Running</h2>
        <div id="running"></div>
      </section>
      <section class="done">
        <h2>Recently Done</h2>
        <div id="done"></div>
      </section>
    </main>
    <dialog id="plan-modal">
      <pre id="plan-content"></pre>
      <button id="approve-btn">Approve plan</button>
      <button id="reject-btn">Reject (terminate)</button>
      <button id="close-modal">Cancel</button>
    </dialog>
    <script>/* fetch /api/workflows every 10s, render, click handlers, plan modal */</script>
  </body>
</html>
```

Click a workflow card in `needsApproval` → modal opens → fetch `/api/workflows/:id` → render plan in modal → operator clicks Approve → POST `/api/workflows/:id/approve` → modal closes → list refreshes.

### What gets shipped in v1

- New package `forge-console/` (Hono + Bun)
- Workflow change: `currentPlanQuery` added to `multiTicketWorkflow`
- Console serves localhost-only on port 4640
- HTML UI with three buckets, plan modal, click-to-approve
- Existing `approve.ts` and `signal.ts` CLIs preserved (scriptable fallbacks)
- README in `forge-console/` covering: how to run on Mac, how to deploy on EC2, how to SSH-tunnel
- Unit-ish smoke check in `forge-console/src/smoke.ts` that asserts the Temporal client connects (mirrors `pipeline-worker/src/smoke/temporal.ts`)
- The existing `pipeline-worker/src/dashboard/server.ts` is **left alone for now** — kept as historical reference until the new console proves itself, then deleted in a follow-up cleanup PR.

### Estimated v1 size

- forge-console/src: ~300 lines TS
- forge-console/src/ui/index.html: ~250 lines (HTML+CSS+JS)
- pipeline-worker/src/workflows/MultiTicketWorkflow.ts: +5 lines
- README + tsconfig + package.json + service unit: ~80 lines

Roughly 700 lines total. Single PR, single feature branch.

---

## v2 — Live Stream (designed, not built)

### Source of events

`claude -p ... --output-format stream-json` already emits a structured event stream over stdout. Each line is JSON like:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Edit","input":{...}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]}}
{"type":"system","subtype":"end_session","total_cost_usd":0.0234}
```

`cc.ts` currently captures all of stdout into a string and returns it as the activity result. **The events are right there; we just need to fork them.**

### Activity-side: the `emitEvent` helper

Add `forge-console/src/event-protocol.ts` (shared protocol — copied into `pipeline-worker/src/lib/event-emit.ts`):

```typescript
export interface ForgeEvent {
  workflowId: string;
  ticketId: string;
  phase: 'implement' | 'verify' | 'patrol';
  ts: string;            // ISO timestamp
  kind: string;          // 'assistant_text' | 'tool_use' | 'tool_result' | 'system' | 'error'
  payload: unknown;      // shape varies by kind; opaque to console
}

const CONSOLE_URL = process.env.FORGE_CONSOLE_URL ?? 'http://127.0.0.1:4640';

export async function emitEvent(event: ForgeEvent): Promise<void> {
  // Best-effort fire-and-forget. Failure is logged but does not propagate
  // because event emission is observability, not correctness.
  try {
    await fetch(`${CONSOLE_URL}/internal/events`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Console is down or unreachable — don't fail the activity.
  }
}
```

Modify `cc.ts` to accept an optional `onEvent` callback:

```typescript
export interface CCSessionOptions {
  // ... existing fields ...
  onEvent?: (rawJsonLine: string) => void;
}

export async function runCCSession(opts: CCSessionOptions): Promise<string> {
  // ... existing setup ...
  let buffer = '';
  child.stdout.on('data', (d: Buffer) => {
    const text = d.toString();
    stdout += text;
    if (opts.onEvent) {
      buffer += text;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) opts.onEvent(line);
      }
    }
  });
  // ... existing rest ...
}
```

Activity code (`implement.ts`, `verify.ts`, etc.) constructs the callback:

```typescript
const ccResult = await runCCSession({
  // ... existing fields ...
  onEvent: (rawLine) => {
    try {
      const parsed = JSON.parse(rawLine);
      void emitEvent({
        workflowId: ctx.info.workflowExecution.workflowId,
        ticketId: ticket.id,
        phase: 'implement',
        ts: new Date().toISOString(),
        kind: parsed.type ?? 'unknown',
        payload: parsed,
      });
    } catch {
      // malformed JSON line — ignore
    }
  },
});
```

`ctx.info` comes from `@temporalio/activity`'s `Context.current()`.

### Console-side: ingestion + ring buffer + SSE

`POST /internal/events`:

```typescript
app.post('/internal/events', async (c) => {
  const event = await c.req.json() as ForgeEvent;
  ringBuffer.push(event.workflowId, event);
  sseSubscribers.broadcast(event.workflowId, event);
  return c.json({ok: true});
});
```

`ringBuffer` is `Map<workflowId, CircularQueue<ForgeEvent>>`, default capacity 1000 per workflow. Eviction policy: when a workflow transitions to terminal state, schedule its buffer for cleanup after 5 minutes (gives operators time to scroll back).

`GET /api/workflows/:id/events` (SSE):

```typescript
app.get('/api/workflows/:id/events', async (c) => {
  const wfId = c.req.param('id');
  return c.streamSSE(async (stream) => {
    // 1. flush ring buffer to bring client up to current
    const history = ringBuffer.get(wfId) ?? [];
    for (const e of history) {
      await stream.writeSSE({data: JSON.stringify(e)});
    }
    // 2. subscribe to live events
    const sub = sseSubscribers.subscribe(wfId);
    try {
      for await (const e of sub) {
        await stream.writeSSE({data: JSON.stringify(e)});
      }
    } finally {
      sub.close();
    }
  });
});
```

### Frontend: the tail pane

Click a `running` card → opens a per-workflow view at `/workflow/:id` (or modal, TBD UX) → opens `EventSource('/api/workflows/:id/events')` → events scroll into a styled tail pane:

- `assistant_text` → grey paragraph
- `tool_use` (Edit, Write, Bash, Read, etc.) → expandable card with tool name + input
- `tool_result` → indented under the matching tool_use (correlated by `tool_use_id`)
- `system` (end_session, etc.) → divider with cost summary

Filter controls (default-on filters: hide `tool_result`, hide raw `system`). Operator can toggle.

### Network topology

When console runs on EC2 (production), `FORGE_CONSOLE_URL=http://127.0.0.1:4640` is the worker's view. Same host. No exposure required.

When console runs on operator Mac (development), worker is on EC2 — worker can't reach Mac. Two options:

1. Console is **always** colocated with worker. Operator never runs console locally pointed at remote worker. Dev mode = local worker too.
2. Set up a Tailscale link, give the worker `FORGE_CONSOLE_URL=http://<mac-tailnet-name>:4640`.

**Recommendation: option 1.** Stream is for production observation, not dev. Dev mode runs everything local.

### Open questions for v2

- **Event volume.** A 30-min implement session produces ~hundreds of stream-json lines. POSTing each with a new HTTP connection is wasteful. Optimization: batch events with a 200ms tick, send arrays. Defer to first measurement.
- **Cross-activity correlation.** Within one `pipelineWorkflow`, multiple activities (implement, verify) each spawn their own `claude -p`. Events should carry `phase` so the UI can group by phase. Already in the protocol above.
- **Auth on `/internal/events`.** Currently relies on `127.0.0.1` binding. If we ever expose the console on Tailscale, `/internal/events` should require a shared secret beyond binding. Document as a hardening item.

---

## v3 — Prompt Injection (designed, not built)

### Constraint: `claude -p` is single-shot

`cc.ts` invokes `claude -p "<initial>"` and waits for it to exit. Within that single invocation, there's no way to inject a new user turn — Claude Code's CLI doesn't accept new stdin between turns in `-p` mode. The session ends when the model emits its end-of-turn signal.

So v3 has two distinct injection scopes:

**Scope A: between phases.** After `implement` completes and before `verify` starts, the operator can inject context that carries into `verify`. This is feasible without changing `cc.ts` — just append the operator's prompt to the next phase's `initialMessage`.

**Scope B: within a phase.** Mid-`implement`, operator wants to steer. This requires either:
- Killing the in-flight CC process and restarting it with `--resume <session-id>` and the operator's prompt as the new turn. Loses the in-progress turn's work.
- Refactoring `cc.ts` to invoke Claude Code in interactive mode (no `-p`, drive stdin directly). Substantial change; need to handle session lifecycle, multi-turn loops, error semantics.

**Recommendation: ship Scope A in v3.0; defer Scope B to v3.1 with the cc.ts refactor.**

### Workflow side

Add to `pipelineWorkflow`:

```typescript
export const injectPromptSignal = defineSignal<[InjectionPayload]>('injectPromptSignal');

interface InjectionPayload {
  prompt: string;
  scope: 'between-phases' | 'within-phase';  // v3.0 only honors 'between-phases'
  ts: string;
  originator: string;  // operator identifier (for audit)
}

// inside pipelineWorkflow():
const injectionQueue: InjectionPayload[] = [];
setHandler(injectPromptSignal, (payload) => {
  injectionQueue.push(payload);
  log.info('Operator prompt injection queued', {scope: payload.scope, originator: payload.originator});
});

// Before each activity invocation:
const queuedInjections = injectionQueue.splice(0);
const injectionAddendum = queuedInjections
  .filter(i => i.scope === 'between-phases')
  .map(i => `\n\n[Operator injection at ${i.ts} by ${i.originator}]: ${i.prompt}`)
  .join('');

await implementActivity({ticket, worktreePath, extraContext: injectionAddendum});
```

Activity invocation accepts an optional `extraContext` field that gets appended to the initial message passed into `runCCSession`. Cleanly composable.

### Console side

`POST /api/workflows/:id/inject`:

```typescript
app.post('/api/workflows/:id/inject', async (c) => {
  const {prompt, scope = 'between-phases'} = await c.req.json();
  const operator = c.req.header('X-Forge-Operator') ?? 'anonymous';
  const handle = client.workflow.getHandle(c.req.param('id'));
  await handle.signal('injectPromptSignal', {
    prompt,
    scope,
    ts: new Date().toISOString(),
    originator: operator,
  });
  return c.json({ok: true});
});
```

UI: textbox + "Inject" button on each running workflow's view. Submitting POSTs, then UI optimistically shows "queued for next phase boundary" and the actual application is observed via the v2 stream when the next phase starts.

### Audit trail

All injections are recorded in:
- The workflow's signal history (Temporal Cloud retains these).
- The console's stream (echoed as a `kind: 'operator_injection'` event).
- The activity's CC session (the `[Operator injection at ...]` text appears verbatim in the prompt and so in `stream-json` output, naturally durable).

### Risks specific to v3

- **Steering quality.** Whether the model usefully responds to mid-pipeline injections is empirical. Some classes of injection (e.g., "use library X instead of Y") will work great; others (e.g., "scrap that, do the opposite") may produce confused output. This is a UX problem to discover, not a system design problem.
- **Concurrent injections.** Two operators inject conflicting prompts. v3.0 uses `splice(0)` which preserves order; both apply, model gets both. Could add UI hint that "an injection is queued from <other-operator>" when issuing a second one. Defer to v3.1.
- **Within-phase injection complexity.** v3.1's `cc.ts` refactor is a real piece of work — interactive sessions, signal-driven turn injection, error recovery from broken pipes. Don't underestimate.

---

## Phasing & rollout

| Version | Ships | Branch | PR | Status |
|---|---|---|---|---|
| v1.0 | Approval UI: list, view plan, approve, reject (terminate), close. localhost auth. | `feat/forge-console-v1` | TBD | About to start |
| v2.0 | Activity event emission + console SSE stream + UI tail pane. EC2-deployed only. | `feat/forge-console-v2-stream` | future | designed, not built |
| v3.0 | Between-phase prompt injection via `injectPromptSignal`. Audit trail. | `feat/forge-console-v3-inject` | future | designed, not built |
| v3.1 | Within-phase injection — requires `cc.ts` interactive-session refactor. | `feat/forge-console-v3.1-cc-interactive` | future | open question |

Each version's PR is small enough to review in one sitting (v1 is the largest at ~700 lines).

### Slack integration alignment

Existing backlog item: "approval gate notification — Slack alert when workflow enters APPROVAL_WAIT". Folding it in:

- When `multiTicketWorkflow` starts and is awaiting `planApprovedSignal`, the trigger CLI (or the workflow itself via a Slack-posting activity) posts to `#dk-assistant`: a one-liner with workflow ID, ticket count, and a link to `http://127.0.0.1:4640/workflow/<id>` (operator's local console).
- The operator clicks → SSH tunnel resolves → console opens → operator approves.

This is a small additional activity in `pipeline-worker/src/activities/`. Not in v1 scope, but cleanly composable with v1's API surface. Worth including in v1 if scope budget allows; otherwise v1.5.

---

## Open questions

1. **Reject semantics.** v1 treats Reject = Terminate. If you want Reject = re-plan or Reject = mark FAILED-but-keep-history, that's a `pipelineWorkflow` design decision. Flagged; not blocking v1.
2. **Plan modification.** Should the operator be able to edit the plan before approving (delete a ticket, reword a description)? v1: no — review-only. Likely useful eventually; punt.
3. **Multi-tenant operators.** Currently single-operator. If multiple humans need access (Andraz on PTO coverage?), shared-secret auth doesn't carry identity. Punt to v3 when we add `X-Forge-Operator`.
4. **Console-on-Mac vs console-on-EC2.** v1 works either way; v2 strongly prefers console-on-EC2 to make worker → console event POSTing trivial. Settle by v2.
5. **Cleanup of legacy `dashboard/server.ts`.** Keep through v1 PR, delete in a follow-up after the new console proves itself in production for ~1 week. Avoids ripping out a working tool before its replacement is trusted.
6. **Hono dep on EC2.** Adds Hono to `forge-console/package.json`. Need to `npm ci --omit=dev` (or `bun install --production`) on EC2 deploy. Document in deploy runbook.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Workflow query handler version skew (in-flight workflows started before `currentPlanQuery` was deployed) | High | Low (UX degradation, plan won't show inline) | Console falls back to history-scrape; documented behavior. |
| Bun version drift between Mac and EC2 | Medium | Medium (subtle TS / runtime bugs) | Pin Bun version in `forge-console/.bunrc` or document. Already pinned via `bun.lock`. |
| Console becomes a SPOF for v2/v3 | Medium | Medium (operator loses observability if console crashes) | Approval still works via `approve.ts` CLI fallback. Stream is observability, not correctness — durable record is in `logs/`. |
| Event POST from EC2 worker overwhelms console | Low (event volume is bounded by CC's output rate) | Low | Batch events with 200ms tick if measured volume warrants. |
| Operator injects something dangerous mid-pipeline (v3) | Medium | High | All injections are audit-logged in workflow signal history; operator identity required via `X-Forge-Operator`. v3.0's between-phase scope means the model has time to "absorb" the injection cleanly without breaking a tool call mid-flight. |
| Token leakage if `forge-console/load-env.sh` mishandles secrets | Low if implemented carefully | High | Reuse `pipeline-worker/load-env.sh` directly via symlink — single source of truth. Don't duplicate the env-load code. |
| Localhost binding circumvention via DNS rebinding (v2/v3) | Low | Medium | Add `Host` header check (`Host` must be `127.0.0.1:4640` or `localhost:4640`). Hono middleware, ~5 lines. |

---

## Success criteria

**v1 ships when:**

- New operator can:
  1. Trigger a workflow via existing `e2e-probe.ts` or `trigger.ts`.
  2. Open `http://127.0.0.1:4640` in a browser.
  3. See the workflow in "Awaiting Plan Approval".
  4. Click it; see the plan content rendered.
  5. Click Approve.
  6. See the workflow move to "Running".
  7. Watch it complete (via Temporal UI for now; v2 in-console later).
  8. Workflow's PR opens on the target repo as expected.

- Existing `approve.ts` CLI still works (regression-free).
- `npm run smoke` (or `bun run smoke`) in `pipeline-worker/` still passes.
- `forge-console/src/smoke.ts` passes against Temporal Cloud.

**v2 ships when:**

- Open running workflow in console, see live tool calls scroll.
- Events survive page reload (ring buffer replays).
- Console crash doesn't break the workflow (graceful degradation).

**v3 ships when:**

- Operator types prompt, clicks Inject, prompt appears as `[Operator injection ...]` line in the next phase's CC session.
- Audit shows operator identity, timestamp, prompt text.

---

## Next steps

1. **Review.** I want one revision pass on this memo before I start v1. Specifically: (a) Is `forge-console/` as a sibling package the right call vs `pipeline-worker/src/console/`? (b) Hono OK or do you have framework strong opinions? (c) Is the v2 `claude -p` stream-tap the right mechanism vs Heartbeats? (d) v3's between-phase-only initial scope acceptable?

2. **After review, implement v1.** ETA: one focused session. New branch `feat/forge-console-v1`, single PR, target `nexus-main`.

3. **After v1 merges and stabilizes for ~1 week, propose v2 PR.** Doesn't block v1.
