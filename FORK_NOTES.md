# Nexus — implementation notes

Nexus is an orchestration runtime built on top of Claude Code. It runs one
long-lived Claude Code session per *entity* (Orchestrator, Engineer, Advisor,
Monitor, Writer), wires those sessions together with an inbox/dispatch model,
and exposes a daemon process that handles cron-like jobs, heartbeats, and
external chat surfaces (Slack, Telegram, Discord) for a single operator.

This file documents the parts of the runtime that are interesting for
someone reading the code from outside.

## Runtime model

- A *daemon* runs per entity workspace. It owns one Claude Code session
  identified by a `sessionId` written to `.claude/claudeclaw/session.json`
  (the directory name is a historical on-disk convention; nothing here
  depends on the literal string).
- Jobs are markdown files with cron frontmatter + a prompt body, loaded at
  startup from `.claude/claudeclaw/jobs/`. The daemon evaluates schedules
  in the timezone configured in settings.
- Heartbeats are a recurring prompt fired on a fixed interval. They serve
  as an idle-time poke that lets the entity surface anything it noticed.
- A tiny inbox filesystem (`tasks/inbox`, `tasks/done`) lets one entity
  hand work to another by writing a markdown file. Orchestrator delegates to
  Engineer / Advisor / Writer via this path.
- The daemon hot-reloads its settings file every ~30 seconds, so config
  edits apply without restart.

## Configuration surface

`nexus.json` at the workspace root declares the entity topology (paths,
ports, model assignments, notification channels) and the Forge multi-repo
registry. The runtime reads it at startup; entities discover each other
through it.

Per-entity settings live in `.claude/claudeclaw/settings.json` inside each
entity's workspace and cover model selection, security level, heartbeat
schedule, and per-channel chat tokens. See `commands/config.md` for the
full schema.

## Code map (highlights)

- `src/index.ts` — CLI entry point (`start`, `stop`, `send`, `delegate`,
  `entities`, `spawn`, `status`, …).
- `src/runner.ts` — per-entity Claude Code session lifecycle: bootstrap,
  resume, heartbeat tick, external-message dispatch, session lock to
  prevent overlapping `--resume` calls.
- `src/sessionManager.ts` — multi-session map for chat surfaces that have
  the concept of threads (currently Discord).
- `src/jobs.ts` — cron loader / scheduler.
- `src/commands/{slack,telegram,discord}.ts` — external chat surfaces.
- `pipeline-worker/` — the Forge Temporal worker (see `FORGE.md`).
- `forge-console/` — operator UI for Forge runs.

## What is intentionally minimal

The orchestration layer is small on purpose: it is a thin coordinator
around Claude Code sessions, not a framework. Most of the "intelligence"
lives in the entity prompts (`prompts/`, per-entity `CLAUDE.md`) and in
the Forge Temporal workflows. The runtime's job is to keep sessions
alive, route messages between them, and run schedules — nothing more.
