/**
 * Filesystem-based repo classification used by the Forge worker to pick
 * the right dependency-bootstrap step (uv sync vs bun/yarn/npm install)
 * before VERIFY/PR-READINESS run their commands.
 *
 * Detection deliberately reads the worktree, not the registry config:
 * a repo that swaps language (e.g., adds a Vite shell alongside the
 * existing Python service) does not need a config edit — the next clone
 * picks up the new manifest.
 *
 * Precedence: Python wins over Node when both manifests exist. Some
 * Python repos carry a thin `package.json` for tool-only deps (Tailwind,
 * Vite preview) but they're still Python at the build/test level. The
 * caller should react to ambiguity by trusting the language signal here
 * and adjusting nexus.json's lint/test commands rather than fighting it.
 */

import { existsSync } from 'fs';
import { join } from 'path';

export type RepoType =
  | 'python'
  | 'node-bun'
  | 'node-yarn'
  | 'node-npm'
  | 'unknown';

export function detectRepoType(worktreePath: string): RepoType {
  const has = (file: string): boolean => existsSync(join(worktreePath, file));

  if (has('pyproject.toml') || has('requirements.txt') || has('uv.lock')) {
    return 'python';
  }
  if (has('package.json')) {
    if (has('bun.lockb') || has('bun.lock')) return 'node-bun';
    if (has('yarn.lock')) return 'node-yarn';
    return 'node-npm';
  }
  return 'unknown';
}
