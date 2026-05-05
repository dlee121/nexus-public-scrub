# Forge Console

Operator UI for the Forge Temporal pipeline. v1 replaces `pipeline-worker/src/cli/approve.ts` as the primary plan-approval path with a browser interface that lists waiting workflows, shows the wave plan inline, and approves with one click.

Design proposal: `data/FORGE_CONSOLE_PROPOSAL_v1.md`.

## Stack

- Bun (≥1.1) runtime
- [Hono](https://hono.dev/) HTTP framework (~6KB, zero transitive deps)
- Vanilla HTML/JS frontend, no build step
- Reuses Temporal Cloud mTLS connection logic from `pipeline-worker/src/temporal-client.ts` (~15 lines duplicated; intentional)

## Quickstart (operator's Mac, dev mode)

```bash
cd /Users/<user>/Nexus/core/forge-console
bun install
bash -c 'source load-env.sh && bun run smoke'    # one-time connectivity check
bash -c 'source load-env.sh && bun run start'    # binds 127.0.0.1:4640
```

Open http://127.0.0.1:4640.

## Production (EC2 worker host)

```bash
# On EC2, after deploying the package to /opt/nexus/core/forge-console/:
sudo cp /opt/nexus/core/forge-console/forge-console.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now forge-console.service
sudo systemctl status forge-console.service
```

The console binds 127.0.0.1:4640 by default. Operator reaches it via SSH tunnel:

```bash
# From operator's Mac:
ssh -L 4640:localhost:4640 ubuntu@<ec2-host>
# Open http://localhost:4640 in browser, leave SSH session open while using it.
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | HTML UI |
| `GET` | `/healthz` | liveness + namespace + streaming-buffer stats |
| `GET` | `/api/workflows` | list workflows on `forge-pipeline`, classified into 3 buckets |
| `GET` | `/api/workflows/:id` | workflow detail + wave plan content (via `currentPlanQuery`) |
| `POST` | `/api/workflows/:id/approve` | sends `planApprovedSignal` |
| `POST` | `/api/workflows/:id/reject` | terminates the workflow with optional reason |
| `POST` | `/api/workflows/:id/close` | best-effort close (`closeWorkflowSignal` then terminate) |
| `GET` | `/api/workflows/:id/stream` | **(v2)** SSE — live event tail for one workflow |
| `POST` | `/internal/events` | **(v2)** worker → console event ingestion (auth: `X-Forge-Token`) |
| `POST` | `/internal/events/terminal` | **(v2)** worker hint that workflow ended; schedules buffer cleanup |

## Streaming (v2)

The console maintains an in-memory ring buffer of the most recent ~500 events per active workflow (capped at 50 active workflows; LRU evicted; terminal-state buffers held for 5 minutes). pipeline-worker activities POST `claude -p`'s `--output-format stream-json` lines to `/internal/events`; the console fans them out to browser SSE clients via `/api/workflows/:id/stream`.

SSE event types emitted to the browser:
- `forge-event` — a `ForgeEvent` payload (data is JSON-stringified)
- `snapshot-end` — sent once after ring-buffer replay completes (UI signals "now in live tail mode")
- `heartbeat` — keep-alive every 30s

The browser's `EventSource` reconnects automatically on disconnect; on reconnect, the ring-buffer replay brings it back up to date.

### Worker-side wiring

For the worker to emit events, set in `.pipeline-secrets.env`:

```
FORGE_CONSOLE_URL=http://127.0.0.1:4640
FORGE_EVENT_TOKEN=<random shared secret>
```

The same `FORGE_EVENT_TOKEN` must be set on the console's environment. Ingestion is **fail-closed**: if the token is unset on the console, `/internal/events` returns 503. Worker-side, missing env vars make `emitEvent()` a silent no-op — activities continue to function with zero observability rather than fail.

## Configuration

Env vars (all required except where noted, sourced from `.pipeline-secrets.env` via `load-env.sh`):

| Var | Purpose |
|---|---|
| `TEMPORAL_ADDRESS` | Temporal Cloud gRPC endpoint (e.g. `<ns>.<region>.tmprl.cloud:7233`) |
| `TEMPORAL_NAMESPACE` | Temporal namespace (e.g. `[temporal-namespace]`) |
| `TEMPORAL_TLS_CERT_PATH` | Path to mTLS client cert PEM |
| `TEMPORAL_TLS_KEY_PATH` | Path to mTLS client key PEM |
| `FORGE_CONSOLE_PORT` | Bind port (default `4640`) |
| `FORGE_CONSOLE_HOST` | Bind host (default `127.0.0.1`; set to `0.0.0.0` only when fronted by SG/FW) |
| `FORGE_EVENT_TOKEN` | (v2) shared secret for `/internal/events` ingestion. If unset, ingestion is disabled (503). |
| `FORGE_CONSOLE_URL` | (v2, worker-side) base URL the worker POSTs events to. If unset, worker doesn't emit. |

## Security model

- **Default binding is `127.0.0.1`.** No LAN exposure unless explicitly opted into.
- **Host header check.** Even on localhost, the server rejects requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>`. Defends against DNS-rebinding attacks on the operator's browser.
- **No authentication beyond binding** in v1. Adding a shared-secret token (`X-Forge-Token` header) is queued for v3 when irreversible operator actions like prompt injection arrive.
- **Audit trail** lives in Temporal Cloud — all signals and terminations are recorded in workflow history.

## Replacing `approve.ts`

The CLI at `pipeline-worker/src/cli/approve.ts` is preserved as a scriptable fallback. The console's `POST /api/workflows/:id/approve` route is the new primary path. Behavior is identical — both invoke `client.workflow.getHandle(id).signal('planApprovedSignal')`.

## Operational notes

- Workflows that predate this PR may not respond to `currentPlanQuery` (it's added in `pipeline-worker/src/workflows/MultiTicketWorkflow.ts` here). The detail modal shows `currentPlanQuery unavailable` for those; approve via CLI as a fallback or wait for the next deploy of the worker.
- The console's process is stateless. Restarting it loses no data; everything authoritative lives in Temporal Cloud.
- The console does **not** start any worker. Workflows only progress when a worker on the `forge-pipeline` task queue is alive — typically EC2's `forge-worker.service`.

## Roadmap

| Version | Status | Adds |
|---|---|---|
| v1.0 | shipped (PR #3) | Plan approval UI |
| v2.0 | this PR | Live event stream from inside CC activities (taps `claude -p`'s `--output-format stream-json`) |
| v3.0 | designed | Operator prompt injection (between phases) via new `injectPromptSignal` |
| v3.1 | open | Within-phase injection (requires `cc.ts` interactive-session refactor) |

See `data/FORGE_CONSOLE_PROPOSAL_v1.md` for full design.

## Troubleshooting

**`Missing env var TEMPORAL_ADDRESS`** — you forgot to source `load-env.sh` first.

**`Host '...' not allowed`** — your browser is hitting the console with a hostname that isn't `127.0.0.1` or `localhost`. Either use one of those, or set `FORGE_CONSOLE_HOST=0.0.0.0` (and ensure your network controls allow that exposure).

**`currentPlanQuery unavailable: ...`** — the workflow predates the query handler. Approve via `pipeline-worker/src/cli/approve.ts <workflowId>` and consider terminating the old workflow if it's stale.

**`HTTP 500` on `/api/workflows`** — most commonly a stale Temporal connection (cert expired). Run `bun run smoke` to diagnose; rotate certs in `.pipeline-secrets.env` if needed.
