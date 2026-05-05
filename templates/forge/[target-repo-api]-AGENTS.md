# AGENTS.md — [target-repo-api] Forge Incidents

This file records failure modes discovered during pipeline runs.
Rules here are additive — never remove without documented justification.
Distillation trigger: when this file exceeds 45 lines, PATROL proposes a distillation diff.

## Incidents

### 2026-05-04 — `make lint` silently no-ops; isort/black config mismatch

Wave 2 of the per-org quiet-hours feature (Task 5) committed an unformatted file because the CC session ran `make lint`, which uses bare `black`/`isort` not on the EC2 worker's `$PATH` — the command failed silently and the session believed lint passed.

A second, deeper problem surfaced when fixing it: `pyproject.toml` has `[tool.black]` (line-length 78) but no `[tool.isort]` config, so default-profile isort produces hanging-indent multi-line imports while black wants vertical-each-on-own-line. The two formatters can never converge on `application.py` without `profile = "black"`.

**Rule:** never invoke `make lint` for formatting. Always use:

```
uv run isort . && uv run black .
```

then verify with:

```
uv run black --check . && uv run isort --check-only .
```

If either check fails on a file you didn't touch, `pyproject.toml` is missing `[tool.isort] profile = "black"` — add it before formatting (one-time alignment; see PR [org]/[target-repo-api]#50 for the precedent).
