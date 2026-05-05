# Nexus

Orchestration system with autonomous entities coordinated by Orchestrator.

## Structure

```
Nexus/
├── core/              # Runtime engine (separate git repo)
├── entities/
│   ├── orchestrator/         # Orchestrator (Sonnet) — routes and synthesizes
│   ├── engineer/        # Master engineer (Opus) — complex coding & architecture
│   ├── advisor/  # Spirit guide (Opus) — strategy & deep reasoning
│   └── monitor/      # Monitor (Haiku) — heartbeats & health checks
├── nexus.json         # System topology & global config
└── CLAUDE.md          # Workspace instructions for Claude
```

## Setup on a new machine

### 1. Prerequisites

- [Bun](https://bun.sh) runtime
- SSH key added to GitHub with access to `[org]/Nexus`
- Claude Code CLI installed

### 2. Clone

```bash
# Clone the workspace repo
git clone git@github.com:[org]/Nexus.git -b workspace ~/Nexus

# Clone the core runtime inside it
git clone git@github.com:[org]/Nexus.git -b main ~/Nexus/core

# Install core dependencies
cd ~/Nexus/core && bun install
```

### 3. Configure

Update `nexus.json` paths to match your machine:

```json
{
  "entities": {
    "orchestrator": { "path": "/Users/<you>/Nexus", ... },
    "advisor": { "path": "/Users/<you>/Nexus/entities/advisor", ... },
    "monitor": { "path": "/Users/<you>/Nexus/entities/monitor", ... },
    "engineer": { "path": "/Users/<you>/Nexus/entities/engineer", ... }
  },
  "corePath": "/Users/<you>/Nexus/core"
}
```

Update the timezone in `nexus.json` if you're not in Eastern Time:

```json
{
  "timezone": "America/New_York"
}
```
Entity settings inherit this timezone. If you change it, update each entity's per-entity settings file to match.

### 4. Verify

```bash
# Check entity status
bun run core/src/index.ts entities

# Spawn an entity
bun run core/src/index.ts spawn engineer

# Delegate a task
bun run core/src/index.ts delegate engineer "Refactor the auth module to use the new token service"
```

## Entities

| Entity | Model | Port | Purpose |
|--------|-------|------|---------|
| Monitor | Haiku 4.5 | 4634 | Heartbeats, health checks, message scanning (autostart) |
| Orchestrator | Sonnet 4.6 | 4632 | Orchestration, routing, spawns Sonnet subagents for 80% of work |
| Engineer | Opus 4.7 | 4635 | Complex engineering: multi-file refactoring, architecture, security |
| Advisor | Opus 4.7 | 4633 | Strategic advisory, philosophical insight, deep reasoning |

## Model Routing

Route to the cheapest model that handles the task well:

- **Haiku 4.5** — heartbeats, cron jobs, simple lookups, notifications
- **Sonnet 4.6** — Orchestrator + subagents handle code gen, bug fixes, integrations, writing, review (80%)
- **Opus 4.7** — Engineer for hard engineering, Advisor for strategy (10-20%)

## Two repos, one workspace

- **`workspace` branch** — this repo: entities, config, workspace files
- **`main` branch** — core runtime engine (cloned into `core/`)

They share the same GitHub repo but track different content. Core is gitignored from the workspace repo.
