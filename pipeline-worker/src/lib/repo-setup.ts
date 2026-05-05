/**
 * Repo-aware dependency bootstrap for VERIFY and PR-READINESS.
 *
 * Replaces the direct `setupCodeArtifact()` calls in verify.ts /
 * createPR.ts that previously ran `uv sync --frozen` against every
 * worktree, regardless of language. JS/TS repos (e.g. [target-repo-web]) have
 * no `uv.lock`, so the unconditional sync failed the activity outright
 * before lint/test ever ran.
 *
 * Detection happens via `detectRepoType()` which inspects the worktree
 * for known manifests. Python repos get the existing CodeArtifact-backed
 * `uv sync` path (verbatim — same auth flow, same env vars). Node repos
 * get a one-shot install via the package manager that owns the lockfile.
 * Unknown layouts skip the install step and emit a warning so a missing
 * `lint`/`test` command surfaces a clearer error than "uv sync failed".
 */

import { spawnSync } from 'child_process';
import { setupCodeArtifact } from './codeartifact';
import { detectRepoType, type RepoType } from './repo-type';

export interface RepoEnvironment {
  /** Detected repo type — useful for callers that want to log/branch. */
  type: RepoType;
  /**
   * Full env object to pass to subsequent `spawnSync` calls. Already
   * layered onto `process.env` so callers can pass it as-is. Python
   * repos additionally carry the venv pin (`VIRTUAL_ENV`, `UV_NO_SYNC`)
   * and the CodeArtifact PyPI index. Node repos carry only `process.env`.
   */
  env: NodeJS.ProcessEnv;
}

export async function setupRepoEnvironment(worktreePath: string): Promise<RepoEnvironment> {
  const type = detectRepoType(worktreePath);

  if (type === 'python') {
    // Mutates `pythonEnv` in place to add UV_INDEX_URL/UV_EXTRA_INDEX_URL,
    // then runs `uv sync --frozen`. Throws on uv sync failure.
    const pythonEnv: Record<string, string> = {};
    await setupCodeArtifact(worktreePath, pythonEnv);
    return {
      type,
      env: {
        ...process.env,
        ...pythonEnv,
        // Pin the active venv and disable uv's implicit cross-platform
        // resolve. Without UV_NO_SYNC, uv 0.11.7 attempts a lockfile
        // resolution every time VIRTUAL_ENV is set, which fails on
        // Python 3.12+ markers for packages pinned to 3.11.
        VIRTUAL_ENV: `${worktreePath}/.venv`,
        UV_NO_SYNC: '1',
      },
    };
  }

  if (type === 'node-bun' || type === 'node-yarn' || type === 'node-npm') {
    runNodeInstall(worktreePath, type);
    return { type, env: { ...process.env } };
  }

  // Unknown layout — no manifest we recognize. Don't fail; the caller's
  // lint/test command may still work against a vendored worktree (e.g. a
  // pure-shell repo). A warning here makes the skip auditable in the
  // worker journal.
  process.stderr.write(
    `[repo-setup] No recognized package manifest at ${worktreePath} ` +
    `(no pyproject.toml/requirements.txt/uv.lock or package.json). ` +
    `Skipping dependency install — lint/test will run against the worktree as-is.\n`,
  );
  return { type, env: { ...process.env } };
}

function runNodeInstall(
  worktreePath: string,
  type: 'node-bun' | 'node-yarn' | 'node-npm',
): void {
  const recipes: Record<typeof type, { cmd: string; args: string[] }> = {
    'node-bun': { cmd: 'bun', args: ['install'] },
    'node-yarn': { cmd: 'yarn', args: ['install'] },
    'node-npm': { cmd: 'npm', args: ['install'] },
  };
  const { cmd, args } = recipes[type];
  const result = spawnSync(cmd, args, { cwd: worktreePath, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed in setupRepoEnvironment (cwd: ${worktreePath})`,
    );
  }
}
