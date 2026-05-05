import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { ApplicationFailure } from '@temporalio/common';
import { setupRepoEnvironment } from '../lib/repo-setup';
import { createPR } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { Ticket } from '../types';

/**
 * Classify a git-push failure from its stderr output. Categories drive
 * the retry decision (Gap 4 fix) and the Slack BLOCKED message body
 * (Gap 2 fix).
 *
 * - `non-fast-forward` — remote tip diverged from local. Retrying without
 *   changing state is futile; throw nonRetryable so the BLOCKED ping
 *   fires immediately instead of after 3×backoff.
 * - `permission-denied` / `auth` — credential issue. Retryable in
 *   principle (a token may rotate mid-window) but operator likely needs
 *   to act; we still let Temporal retry.
 * - `remote-rejected` — generic remote-side reject (hooks, branch
 *   protection). Retry once in case it's transient.
 * - `other` — unknown shape; retry within budget.
 */
type PushFailureMode =
  | 'non-fast-forward'
  | 'permission-denied'
  | 'auth'
  | 'remote-rejected'
  | 'other';

function classifyPushStderr(stderr: string): PushFailureMode {
  const s = stderr.toLowerCase();
  if (s.includes('non-fast-forward') || s.includes('non fast forward')) return 'non-fast-forward';
  if (s.includes('stale info') || s.includes('rejected') && s.includes('force-with-lease')) return 'non-fast-forward';
  if (s.includes('permission denied') || s.includes('403')) return 'permission-denied';
  if (s.includes('authentication failed') || s.includes('invalid credentials') || s.includes('401')) return 'auth';
  if (s.includes('[remote rejected]') || s.includes('protected branch') || s.includes('hook')) return 'remote-rejected';
  return 'other';
}

export async function createPRActivity(params: {
  ticket: Ticket;
  worktreePath: string;
  branchName: string;
  diffReview: string;
}): Promise<{ prNumber: number; prUrl: string; prTitle: string; repoFullName: string; headSha: string }> {
  const { ticket, worktreePath, branchName, diffReview } = params;
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);

  // Repo-aware bootstrap. Python repos hit CodeArtifact + `uv sync`,
  // Node repos run their package manager's install. The pr_readiness.sh
  // script below is generic (mypy/ruff guarded by command -v) so the env
  // it inherits doesn't need Python-specific overlays beyond what the
  // bootstrap already returned.
  const { env: codeartifactEnv } = await setupRepoEnvironment(worktreePath);

  // Fail fast if IMPLEMENT produced no commits beyond origin/<defaultBranch>.
  // Without this guard, `gh pr create` returns 'No commits between …' and
  // the activity wastes 3 Temporal retries on a non-recoverable state.
  const commitCountResult = spawnSync(
    'git',
    ['-C', worktreePath, 'rev-list', '--count', `origin/${repoConfig.defaultBranch}..HEAD`],
    { encoding: 'utf-8' },
  );
  if ((commitCountResult.stdout ?? '').trim() === '0') {
    throw ApplicationFailure.nonRetryable('No commits on branch — IMPLEMENT made no changes');
  }

  // Run pr_readiness.sh (scaffold if absent)
  const readinessScript = join(worktreePath, 'scripts/claude_code_harness/pr_readiness.sh');
  if (!existsSync(readinessScript)) {
    mkdirSync(dirname(readinessScript), { recursive: true });
    writeFileSync(readinessScript, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "[pr_readiness] Running checks..."',
      'if command -v mypy &>/dev/null && [ -f mypy.ini ] || [ -f setup.cfg ]; then',
      '  mypy . --ignore-missing-imports || true',
      'fi',
      'if command -v ruff &>/dev/null; then',
      '  ruff check . || true',
      'fi',
      'echo "[pr_readiness] Done."',
    ].join('\n') + '\n');
    chmodSync(readinessScript, 0o755);
  }
  const readinessResult = spawnSync('bash', ['scripts/claude_code_harness/pr_readiness.sh'], {
    cwd: worktreePath, env: codeartifactEnv, stdio: 'inherit',
  });
  if (readinessResult.status !== 0) throw new Error('pr_readiness.sh failed');

  // Push branch.
  //
  // `--force-with-lease` (Gap 1 belt): refuses to push if the remote tip
  // diverged from what our local-tracking ref last saw. Combined with the
  // per-run timestamp suffix on `branchName` (the suspenders, set in
  // implementActivity), collisions across Forge runs that reuse a ticket
  // id are eliminated — this branch name is fresh, so the lease is empty
  // and the push always succeeds at the protocol level. The flag stays
  // for the edge case where a remote branch with the same suffix
  // somehow exists (timestamp collision is ~1-in-10M but possible).
  //
  // Capture stderr (Gap 2): on failure we classify the rejection mode
  // and propagate it through the thrown error so the BLOCKED Slack ping
  // is actionable without reading the journal.
  const pushResult = spawnSync(
    'git',
    ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`],
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  if (pushResult.status !== 0) {
    const stderr = (pushResult.stderr ?? '') + (pushResult.stdout ?? '');
    const mode = classifyPushStderr(stderr);
    const tail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    const summary = `git push failed for branch ${branchName} [${mode}]: ${tail}`;
    // Gap 4: non-fast-forward never recovers between retries — short-
    // circuit so BLOCKED fires in 1s instead of after 3×5s backoff.
    if (mode === 'non-fast-forward') {
      throw ApplicationFailure.nonRetryable(summary);
    }
    // Other modes (auth, remote-rejected, other) may rotate mid-window
    // or be transient; keep them in the regular retry budget.
    throw new Error(summary);
  }

  // Get head SHA
  const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' });
  const headSha = shaResult.stdout.trim();

  // Create PR
  const prBody = [
    `## ${ticket.title}`,
    ``,
    ticket.description,
    ``,
    `### Acceptance Criteria`,
    ...ticket.acceptanceCriteria.map(c => `- [ ] ${c}`),
    ``,
    `### Code Review Summary`,
    '```json',
    diffReview,
    '```',
    ``,
    `Implemented by Forge (ticket: ${ticket.id})`,
  ].join('\n');

  const prTitle = `[${ticket.id}] ${ticket.title}`;
  const { number: prNumber, url: prUrl } = await createPR({
    owner: repoConfig.repoOwner,
    repo: repoConfig.repoName,
    title: prTitle,
    body: prBody,
    head: branchName,
    base: repoConfig.defaultBranch,
  });

  return {
    prNumber,
    prUrl,
    prTitle,
    repoFullName: `${repoConfig.repoOwner}/${repoConfig.repoName}`,
    headSha,
  };
}
