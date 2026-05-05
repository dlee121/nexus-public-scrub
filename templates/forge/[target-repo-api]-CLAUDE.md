# Forge Pipeline — [target-repo-api]

You are an autonomous engineering agent implementing a specific task. You are running inside the Forge pipeline.

## Core Rules

**Think before coding.** Before writing any code, state your implementation plan in 2-3 sentences.

**Simplest correct implementation.** No gold-plating. No speculative features. Implement exactly what the ticket asks, nothing more.

**Surgical changes.** Minimize the diff. Touch only what the task requires.

**Tests first.** Write tests before implementation. Run them to confirm they fail, then implement to make them pass.

**Run checks before declaring done.** Before exiting, run:
- `make lint` — must pass (runs black + isort)
- `uv run pytest -m "not integration and not manual" -n auto` — must pass

**No orphaned changes.** Every file you create or edit must be committed before exiting. Run `git status` to confirm.

## Repo Conventions ([target-repo-api])

- Python 3.11. Package manager: `uv`. Formatter: `black` + `isort` (run via `make lint`).
- Test runner: `pytest` (config in `pytest.ini`), markers include `unit`, `integration`, `manual`. Forge's `testCommand` runs `not integration and not manual`.
- Single-file Flask-RESTful app at `application.py` (~7000 lines) — most route handlers and business logic live here. Helpers under `src/utils/` and routes under `src/routes/`.
- Auth: HS256 JWT with shared secret (`JWT_SECRET` env var); see `src/utils/oauth.py` for sign/verify. Existing `_authenticate()` helper in `application.py` is the canonical Bearer gate — reuse it for new authed endpoints rather than reimplementing.
- Werkzeug pinned to 2.2.3 — newer kwargs (e.g. `set_cookie(..., partitioned=True)`) won't work; rewrite the Set-Cookie header post-hoc if you need them.
- Deploy: `make deploy` (Elastic Beanstalk). Forge does NOT auto-trigger deploys on merge for this repo — DK runs deploys manually for now. **TODO**: wire actual auto-deploy commands when DK greenlights forge-driven deploys for this repo.
- Do NOT modify `pyproject.toml` lock state by hand; let `uv` regenerate.
- Do NOT introduce new external dependencies without justification.
- Bugbot is `cursor[bot]`. Required CI checks: `ci`, `lint` (conservative default; can add more once pipeline is proven on this repo).

## When Done

Run `/requesting-code-review` before your final exit to signal the pipeline that implementation is complete.
