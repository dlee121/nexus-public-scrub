import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { setupRepoEnvironment } from '../lib/repo-setup';
import { reviewDiff } from '../lib/openai';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { PipelineConfig, Ticket } from '../types';

/**
 * POSIX-safe single-quote escape — wraps the value in single quotes and
 * escapes any embedded single quotes via `'\''`. Used to splice changed
 * file paths into the `bash -lc <cmd>` invocation without risk of word
 * splitting or globbing on paths that contain spaces, glob metacharacters,
 * or quotes.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compute the list of files changed in the worktree relative to the repo's
 * default branch, optionally filtered to a set of file extensions.
 *
 * Uses three-dot range so the result mirrors what GitHub shows in the PR
 * diff (i.e. files changed since the merge-base, not the whole symmetric
 * difference). `--diff-filter=ACMR` includes Added/Copied/Modified/Renamed
 * paths and excludes Deleted — passing a deleted file to a linter just
 * makes it complain about a missing path.
 *
 * Compares against `origin/<defaultBranch>` rather than the local
 * `<defaultBranch>` ref. The worker fetches `origin` before each worktree
 * creation (see lib/worktree.ts:createWorktree), so `origin/main` is
 * always current — but the local `main` ref in the source repo is never
 * fast-forwarded, so it can lag arbitrarily far behind. Using local
 * `main` here pulled files merged after the source repo's last fetch
 * into the diff, blowing up diff-aware lint with unrelated, possibly
 * non-compliant files.
 *
 * The extra `existsSync` filter is defensive against edge cases (e.g. a
 * file that was added then deleted across multiple commits in the branch)
 * — the diff-filter alone usually handles this, but the cost of the check
 * is trivial and it keeps the contract "every returned path can be read".
 */
function computeChangedFiles(opts: {
  worktreePath: string;
  defaultBranch: string;
  extensions?: string[];
}): string[] {
  const { worktreePath, defaultBranch, extensions } = opts;
  const result = spawnSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      `origin/${defaultBranch}...HEAD`,
    ],
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `git diff --name-only failed in VERIFY (status ${result.status}): ${result.stderr}`,
    );
  }
  const all = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const existing = all.filter((rel) => existsSync(join(worktreePath, rel)));

  if (!extensions || extensions.length === 0) return existing;
  const allowed = new Set(extensions.map((e) => e.toLowerCase()));
  return existing.filter((rel) => {
    const dot = rel.lastIndexOf('.');
    if (dot < 0) return false;
    return allowed.has(rel.slice(dot).toLowerCase());
  });
}

/**
 * Run lint over the diff or the whole worktree depending on whether the
 * repo has opted into diff-aware linting via `lintDiffCommand`.
 *
 * Diff-aware path: invokes `<lintDiffCommand> <file1> <file2> ...`. If no
 * changed files match the extension whitelist, the lint step is a no-op
 * success — mirrors GitHub's "Files changed: 0" semantics for the lint
 * tool's perspective. This is how [target-repo-web]'s pre-existing ~1k legacy
 * ESLint errors are kept out of Forge's verdict; the current branch only
 * answers for files it actually touched.
 *
 * Whole-repo fallback: invokes `lintCommand` exactly as before. Repos that
 * don't set `lintDiffCommand` keep the legacy behavior, so adoption is
 * opt-in per repo.
 */
function runLint(opts: {
  repoConfig: PipelineConfig;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
}): void {
  const { repoConfig, worktreePath, env } = opts;

  if (repoConfig.lintDiffCommand) {
    const changed = computeChangedFiles({
      worktreePath,
      defaultBranch: repoConfig.defaultBranch,
      extensions: repoConfig.lintDiffExtensions,
    });
    if (changed.length === 0) {
      process.stdout.write(
        `[verify] diff-aware lint: no changed files match ` +
        `${JSON.stringify(repoConfig.lintDiffExtensions ?? [])} — skipping lint\n`,
      );
      return;
    }
    const filesArg = changed.map(shellEscape).join(' ');
    const cmd = `${repoConfig.lintDiffCommand} ${filesArg}`;
    process.stdout.write(
      `[verify] diff-aware lint: ${changed.length} file(s) → ${repoConfig.lintDiffCommand}\n`,
    );
    const result = spawnSync('bash', ['-lc', cmd], {
      cwd: worktreePath, env, stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(
        `${repoConfig.lintDiffCommand} failed in VERIFY (diff-aware lint over ${changed.length} file(s))`,
      );
    }
    return;
  }

  const result = spawnSync('bash', ['-lc', repoConfig.lintCommand], {
    cwd: worktreePath, env, stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${repoConfig.lintCommand} failed in VERIFY`);
  }
}

/**
 * Run unit tests over the diff or the whole worktree, mirroring `runLint`.
 *
 * Diff-aware path: invokes `<testDiffCommand> <file1> <file2> ...` with the
 * branch's changed files filtered by `testDiffExtensions`. When the diff
 * touches no matching files, the test step is a no-op success — VERIFY
 * answers only for what the branch changed; the full battery still runs
 * in CI on the PR downstream.
 *
 * Rationale: [target-repo-api] has ~50 tests that hit external services
 * (e.g. https://b2b.api.lylt.io) and fail in the worker sandbox regardless
 * of the diff. Without diff-aware tests, a docstring-only PR fails VERIFY
 * for reasons unrelated to its diff, the same shape of problem that
 * `lintDiffCommand` solves for [target-repo-web]'s ~1k legacy ESLint errors.
 *
 * Caveat: a source-only change (e.g. editing src/foo.py without touching
 * tests/test_foo.py) runs zero tests under this mode. Acceptable for a
 * pre-PR gate — CI on the PR is authoritative — but worth knowing. A
 * future source→test mapper could expand the file set if needed.
 *
 * Whole-repo fallback: invokes `testCommand` exactly as before. Repos that
 * don't set `testDiffCommand` keep the legacy behavior; adoption is opt-in.
 */
function runTests(opts: {
  repoConfig: PipelineConfig;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
}): void {
  const { repoConfig, worktreePath, env } = opts;

  if (repoConfig.testDiffCommand) {
    const changed = computeChangedFiles({
      worktreePath,
      defaultBranch: repoConfig.defaultBranch,
      extensions: repoConfig.testDiffExtensions,
    });
    if (changed.length === 0) {
      process.stdout.write(
        `[verify] diff-aware tests: no changed files match ` +
        `${JSON.stringify(repoConfig.testDiffExtensions ?? [])} — skipping tests\n`,
      );
      return;
    }
    const filesArg = changed.map(shellEscape).join(' ');
    const cmd = `${repoConfig.testDiffCommand} ${filesArg}`;
    process.stdout.write(
      `[verify] diff-aware tests: ${changed.length} file(s) → ${repoConfig.testDiffCommand}\n`,
    );
    const result = spawnSync('bash', ['-lc', cmd], {
      cwd: worktreePath, env, stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(
        `${repoConfig.testDiffCommand} failed in VERIFY (diff-aware tests over ${changed.length} file(s))`,
      );
    }
    return;
  }

  const result = spawnSync('bash', ['-lc', repoConfig.testCommand], {
    cwd: worktreePath, env, stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${repoConfig.testCommand} failed in VERIFY`);
  }
}

export interface VerifyResult {
  passed: boolean;
  diffReview: string;
}

export async function verifyActivity(params: {
  ticket: Ticket;
  worktreePath: string;
}): Promise<VerifyResult> {
  const { ticket, worktreePath } = params;
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);

  // Repo-aware bootstrap. For Python repos this fetches the CodeArtifact
  // token, runs `uv sync --frozen`, and returns env layered with the
  // venv pin (VIRTUAL_ENV + UV_NO_SYNC=1 — see lib/repo-setup.ts for the
  // uv 0.11.7 lockfile-resolution failure mode this guards). For Node
  // repos it runs the matching `bun/yarn/npm install` and returns plain
  // process.env. Unknown layouts skip the install step with a warning.
  const { env: codeartifactEnv } = await setupRepoEnvironment(worktreePath);

  // Auto-fix formatting/linting before checking — CC sessions sometimes
  // introduce minor formatter violations. Best-effort; missing target is
  // swallowed silently. Repos without a fixCommand skip this step.
  if (repoConfig.fixCommand) {
    spawnSync('bash', ['-lc', repoConfig.fixCommand], {
      cwd: worktreePath, env: codeartifactEnv, stdio: 'ignore',
    });
  }

  // Lint — diff-aware when `lintDiffCommand` is configured, else whole-repo.
  // See `runLint` above for the rationale (insulates Forge from large
  // legacy-error baselines like [target-repo-web]'s ~1k pre-existing ESLint
  // errors).
  runLint({ repoConfig, worktreePath, env: codeartifactEnv });

  // Type check (optional — only repos that define tyCheckCommand opt in).
  // UV_INDEX_URL pinned to pypi.org to match CI behavior for Python repos.
  if (repoConfig.tyCheckCommand) {
    const tyResult = spawnSync('bash', ['-lc', repoConfig.tyCheckCommand], {
      cwd: worktreePath,
      env: { ...codeartifactEnv, UV_INDEX_URL: 'https://pypi.org/simple' },
      stdio: 'inherit',
    });
    if (tyResult.status !== 0) {
      throw new Error(`${repoConfig.tyCheckCommand} failed in VERIFY`);
    }
  }

  // Unit tests — diff-aware when `testDiffCommand` is configured, else whole-repo.
  // See `runTests` above for the rationale (insulates VERIFY from pre-existing
  // network/external-service test failures like [target-repo-api]'s ~50
  // CORS/HTTP tests that target b2b.api.lylt.io and fail in the worker sandbox).
  runTests({ repoConfig, worktreePath, env: codeartifactEnv });

  // Smoke tests are NOT run here — they need the dev environment to be
  // up and reachable, which a freshly-cloned worktree on the worker host
  // doesn't have. The realtime-platform's `make smoke-test-containers`
  // expects running services it can probe; running it pre-deploy fails
  // immediately with "no containers". MONITOR (post-deploy) is the
  // correct place — see activities/monitor.ts. (Originally added here
  // in commit ca1daff; moved post-deploy after the recovery dogfood
  // run on 2026-05-03 hit exactly this issue.)

  // GPT diff review against the configured default branch.
  const diffResult = spawnSync(
    'git',
    ['diff', `${repoConfig.defaultBranch}...HEAD`],
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  const diff = diffResult.stdout ?? '';

  // Wrap the GPT call so a transport-layer failure (auth/rate-limit/
  // network) surfaces with full context. Without this, Temporal's
  // activity retry would still kick in (good), but persistent failures
  // would land in the workflow with a bare `Error: 401 Unauthorized`
  // and no hint that it came from reviewDiff. The wrapper preserves
  // the original error via `cause` so the stack is intact.
  let diffReview: string;
  try {
    diffReview = await reviewDiff(diff, ticket.title);
  } catch (err) {
    const origMsg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    throw new Error(
      `verifyActivity: reviewDiff (GPT-4.1 — Azure primary, GitHub Models fallback) failed${status ? ` HTTP ${status}` : ''}: ${origMsg}. ` +
      `Likely causes: (a) AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_API_KEY unset or invalid AND no GITHUB_TOKEN fallback configured, ` +
      `(b) Azure 429/5xx and GitHub Models quota also exhausted, or (c) network. ` +
      `If persistent, check /run/forge-worker.env for AZURE_OPENAI_* + GITHUB_TOKEN and retry from EC2 with the proof-of-life command.`,
      { cause: err as Error },
    );
  }

  let reviewObj: { issues?: Array<{ severity?: string }> };
  try {
    reviewObj = JSON.parse(diffReview);
  } catch (err) {
    throw new Error(
      `verifyActivity: reviewDiff returned non-JSON output (first 400 chars: ${diffReview.slice(0, 400)})`,
      { cause: err as Error },
    );
  }
  const criticalIssues = (reviewObj.issues ?? []).filter((i: { severity?: string }) => i.severity === 'critical');
  if (criticalIssues.length > 0) {
    throw new Error(`GPT diff review found critical issues:\n${JSON.stringify(criticalIssues, null, 2)}`);
  }

  return { passed: true, diffReview };
}
