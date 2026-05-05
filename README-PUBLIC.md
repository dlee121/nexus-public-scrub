# Nexus + Forge — redacted public snapshot

This is a redacted snapshot of two systems that share one codebase:

- **Nexus** — an orchestration runtime built on top of Claude Code. It
  runs one long-lived Claude Code session per *entity* (Orchestrator, Engineer,
  Advisor, Monitor, Writer), wires those sessions together with an
  inbox/dispatch model, and exposes a daemon that handles cron-like jobs,
  heartbeats, and external chat surfaces (Slack, Telegram, Discord) for
  a single operator. Entities collaborate: the orchestrator (Orchestrator)
  delegates engineering work to the master engineer (Engineer), strategic
  questions to Advisor, content work to Writer, and so on.
- **Forge** — an autonomous multi-repo development pipeline that lives
  inside Nexus. Built on Temporal Cloud. Given a single operator
  instruction, it plans the work into ordered Linear tickets and drives
  each ticket through implement → verify → PR → CI → review → merge →
  deploy on its own. The operator gates the plan up front and the prod
  deploy at the end; the rest is autonomous.

Credentials, internal hostnames, and org-specific identifiers have been
removed. The source code structure, Forge pipeline logic, and entity
architecture are representative of the real system.

## Reading order

For a quick architectural skim:

1. **`README.md`** — top-level Nexus overview.
2. **`FORGE.md`** — the Forge pipeline: state machine, wave/ticket/gate
   model, how it uses Claude Code sessions.
3. **`nexus.json`** — entity topology + Forge multi-repo registry.
4. **`src/index.ts`** and **`src/runner.ts`** — Nexus runtime entry and
   the per-entity Claude Code session lifecycle.
5. **`pipeline-worker/src/types.ts`** — Forge's type contracts (Ticket,
   WavePlan, PipelineState, PipelineConfig).
6. **`pipeline-worker/src/workflows/`** — the Temporal workflows:
   `MultiTicketWorkflow` (parent orchestrator with plan gate),
   `PipelineWorkflow` (per-ticket state machine, longest single file in
   the repo and worth reading end-to-end), `DeployCoordinatorWorkflow`
   (deploy coalescing), `PatrolWorkflow` (recurring quality patrol).
7. **`pipeline-worker/src/activities/`** — the implement / verify / review
   / merge / deploy activity surface. `implement.ts` shows how a phase
   becomes a Claude Code session.
8. **`forge-console/src/`** — the operator UI: workflow list, SSE
   transcripts, plan-approval and prod-deploy gates.
9. **`data/task5-transcript.md`** — fully-redacted log of a real
   three-repo, multi-ticket Forge execution end-to-end. The clearest
   single artifact for understanding what an actual run looks like.

## What was redacted

| Original | Replaced with |
|---|---|
| Temporal Cloud namespace | `[temporal-namespace]` |
| EC2 host IP / SSH targets | `[redacted-host]` |
| Elastic Beanstalk env hostname | `[redacted-host]` |
| Slack channel IDs | `[slack-id]` |
| AWS account ID | `[aws-account-id]` |
| Linear team UUID | `[linear-team-id]` |
| Company GitHub org names (`Ruby-Labs`, `ruby-dlee`, `rubydata`) | `[org]` |
| Company-affiliated email/hostname domains | `[company-domain]` |
| Brand names | `[Company]` / `[company]` |
| Operational Slack bot user handle | `[bot-user]` |

## What was removed entirely

- `.git/` — shallow-clone history (avoids leaking pre-redaction blobs).
- `entities/` — private workspace configs and entity prompts.
- `data/content/` — operational content-pipeline data.
- Any `.env`, `*-secrets.env`, `*.secrets`, or session backup files
  (none were present beyond the empty `.mcp-secrets.env.example`
  template, which is retained).
- Internal upstream-sync tooling (`UPSTREAM_SYNC.md`, the upstream-sync
  scripts, `forkUpdatePrompt.txt`, the cron job that ran them) — they
  only function in the private fork-maintenance context and add no
  architectural value.
- The pre-implementation spec (`MULTI_SESSION_SPEC.md`) and its
  associated `TASK.md`, since `docs/MULTI_SESSION.md` is the canonical
  technical reference for that feature.
- Brand-asset banner SVG.

## What was preserved

- All TypeScript / shell / Python source under `src/`,
  `pipeline-worker/`, `forge-console/`, `scripts/`, `hooks/`.
- `nexus.json` (structure preserved; sensitive values redacted).
- `templates/forge/*` (Forge per-repo CLAUDE.md / AGENTS.md briefs that
  the IMPLEMENT session loads).
- `data/task5-transcript.md` (already redacted via prior PR).
- Top-level docs: `README.md`, `FORGE.md`, `DEPLOYMENT.md`,
  `FORK_NOTES.md`, `CLAUDE.md`, `docs/`, `commands/`, `prompts/`,
  `skills/`.
- Per-entity runtime state directory (`.claude/claudeclaw/` on disk —
  the directory name is a historical on-disk convention, nothing in
  the architecture depends on the literal string).

## Caveats

- This snapshot is **not** a runnable build target out of the box;
  redacted env values would need to be filled in for the system to
  start. It is intended for code reading and architectural review.
- Repository names (`[target-repo-realtime]`, `[target-repo-api]`,
  `[target-repo-web]`) appear in `nexus.json` and Forge templates because
  they are part of the Forge multi-repo registry's structural shape.
  The owning GitHub org has been redacted; the names alone don't
  pinpoint the company.
