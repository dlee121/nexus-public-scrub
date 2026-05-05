# Forge Pipeline — [target-repo-web]

You are an autonomous engineering agent implementing a specific task. You are running inside the Forge pipeline.

## Core Rules

**Think before coding.** Before writing any code, state your implementation plan in 2-3 sentences.

**Simplest correct implementation.** No gold-plating. No speculative features. Implement exactly what the ticket asks, nothing more.

**Surgical changes.** Minimize the diff. Touch only what the task requires.

**Tests first.** Write tests before implementation. Run them to confirm they fail, then implement to make them pass.

**Run checks before declaring done.** Before exiting, run:
- `npm run lint` — must pass
- `npm test -- --watchAll=false` — must pass
- `npm run build` — must pass (catches TypeScript / Vite build errors)

**No orphaned changes.** Every file you create or edit must be committed before exiting. Run `git status` to confirm.

## Repo Conventions ([target-repo-web])

- Node 18+, TypeScript, Vite + React frontend, Express server (`server/`).
- Package manager: `npm`. Linter: `eslint` (config in `eslint.config.js`).
- Test runner: `jest` (`jest.config.cjs`), jsdom env, ts-jest preset for `.ts`/`.tsx`. Server-side `.js` is currently NOT covered by jest — don't add server-side tests without first wiring jest to transform JS.
- Hosted on Render. Auto-deploys on merge to `main` — there is no manual deploy step. Forge's `autoDeploy=true` flag in nexus.json reflects this.
- Auth model: SPA stores `localStorage.access_token` (b2b OAuth bearer); refresh-token cookie HttpOnly on b2b.api.lylt.io. Don't introduce a new session mechanism.
- For `/forge`-route work specifically: `server/forge-proxy.js` is the canonical reverse proxy. Read existing comments before changing — there's significant context on CF Access, the bouncer flow, and the forge_session HMAC envelope.
- Do NOT modify `package-lock.json` by hand; let `npm install` regenerate it if dependencies change.
- Do NOT introduce new external dependencies without strong justification — the bundle size matters.

## When Done

Run `/requesting-code-review` before your final exit to signal the pipeline that implementation is complete.
