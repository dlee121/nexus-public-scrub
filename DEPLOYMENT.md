# Deployment guide (clean runtime machine)

This document describes how to deploy Nexus onto a clean secondary machine **without mixing runtime entity state into the code repo**.

## Recommended directory layout

Use a single top-level folder and keep code vs entities separate:

- `~/nexus/core` — the Nexus code repo (git clone)
- `~/nexus/entities/<entity-name>/` — entity workspaces (NOT in git)

Important: Nexus stores per-entity runtime state in a hidden directory under each entity's working directory. That means:

- If you run Nexus from `~/nexus/entities/<entity-name>`, runtime state stays with that entity.
- Do **not** run the daemon from inside `~/nexus/core` for real deployments (only for dev).

## Prerequisites

- Claude Code installed and usable on the runtime machine.
- Bun installed (this repo uses Bun).

## Install / update the code (first deploy)

```bash
mkdir -p ~/nexus
cd ~/nexus
git clone git@github.com:[org]/Nexus.git core
cd ~/nexus/core
bun install
```

## Create an entity workspace (runtime state lives here)

```bash
mkdir -p ~/nexus/entities/my-entity
cd ~/nexus/entities/my-entity
```

At this point, all runtime files (settings, jobs, session ids, logs) live under that entity's directory. This is intentionally **not** part of the code repo.

## Running Nexus from an entity workspace

One simple pattern is to invoke the repo’s entrypoint while the current directory is the entity:

```bash
cd ~/nexus/entities/my-entity
bun run ~/nexus/core/src/index.ts start
```

If you want a stable command, create a small shell alias or wrapper on the runtime machine (outside git) that runs the repo entrypoint from the entity directory.

## Credentials and configuration

Project policy:

- **Secrets** should be stored and retrieved from **AWS Secrets Manager**.
- **Configuration** should be provided via **AWS AppConfig**.
- Use local `.env` files minimally (typically only AWS credentials/region to reach AppConfig/Secrets Manager).

Do not commit any credentials. `.env*` is ignored by `.gitignore`.

## Updating deployed code later (without harming entity data)

Entity state is in `~/nexus/entities/...` and code is in `~/nexus/core`, so updates are safe:

```bash
cd ~/nexus/core
git fetch origin
git checkout nexus-main
git pull --ff-only
bun install
```

Then restart the running daemon/process for the entity workspaces as needed.

