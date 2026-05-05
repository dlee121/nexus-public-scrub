import { spawnSync } from 'child_process';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { CC_PHASE_CONFIG } from '../lib/cc';
import { runCCSessionStreamed } from '../lib/cc-streamed';
import { emitEvent } from '../lib/event-emit';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { Ticket } from '../types';

export interface AddressReviewResult {
  /** New HEAD sha after fixes were committed and pushed. */
  headSha: string;
  /** Number of new commits added by the address-review session. */
  newCommitCount: number;
  /** Absolute path to the CC session JSONL the address-review subprocess wrote, or null if not captured. */
  sessionJsonlPath: string | null;
}

/**
 * Apply fixes for findings raised by /review. Spawns a CC session in the
 * same PR worktree with the review comment as input. Returns the new
 * head sha and the number of commits added (zero is allowed and
 * meaningful — see contract below).
 *
 * Contract:
 *   - Worktree must be on the PR branch with the prior commits intact
 *     (set up by implementActivity, advanced by previous address-review
 *     cycles when the bounded loop runs more than once).
 *   - Session may produce zero or more new commits.
 *       * >0 commits → push to origin/<branchName>; re-CI runs against
 *         the new head.
 *       * 0 commits → no push, no re-CI. Signals "every finding was
 *         either false-positive, accept-with-justification, or
 *         out-of-scope-and-queued — nothing to address in code."
 *         Workflow uses this signal to break out of the review loop and
 *         proceed to merge, instead of looping forever on unchanged
 *         feedback (the PR #177 trap, where empty audit-trail commits
 *         masked "nothing to do" as "we did something").
 *   - The session is responsible for replying on the PR thread to
 *     out-of-scope items and queuing them via queue-add.js. Audit trail
 *     for "we considered this and declined" lives in the session
 *     transcript, not in noisy empty git commits.
 *
 * The bounded retry loop lives in PipelineWorkflow, NOT here. This
 * activity is a single fix-and-push; the workflow decides how many
 * cycles to allow and what to do when nothing was changed.
 */
export async function addressReviewActivity(params: {
  ticket: Ticket;
  prNumber: number;
  worktreePath: string;
  branchName: string;
  reviewComment: string;
  /**
   * Cycle number in the bounded REVIEW → ADDRESS_REVIEW → re-CI loop
   * (1-indexed). Surfaced in the prompt so the address session knows
   * whether it's a first attempt or a retry of an earlier fix that
   * still didn't satisfy the reviewer.
   */
  cycle: number;
}): Promise<AddressReviewResult> {
  const { ticket, prNumber, worktreePath, branchName, reviewComment, cycle } = params;
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);

  const ctx = Context.current();
  const workflowId = ctx.info.workflowExecution.workflowId;
  const activityId = ctx.info.activityId;

  // Snapshot HEAD before the session so we can count new commits afterward.
  const preHeadResult = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  if (preHeadResult.status !== 0) {
    throw new Error(`addressReview: failed to read HEAD before session: ${preHeadResult.stderr}`);
  }
  const preHead = preHeadResult.stdout.trim();

  const message = [
    `PR #${prNumber} on ${repoConfig.repoOwner}/${repoConfig.repoName} received the following review feedback.`,
    `The feedback may include up to three channels:`,
    `  - "Forge VERIFY-time GPT review" — the JSON output of reviewDiff() run during VERIFY,`,
    `    embedded in the PR body. Each issue has a severity (info/minor/moderate/critical).`,
    `    Critical-severity findings already failed VERIFY upstream; everything else flowed through.`,
    `    YOU are responsible for addressing non-info findings here.`,
    `  - "Forge /review skill comment" — the self-review comment posted post-CI.`,
    `  - "External comments" — Cursor Bugbot, human reviewers, other bots. Treat these with`,
    `    equal weight — "informational" or "non-blocking" labels do NOT mean "skip".`,
    cycle > 1
      ? `\nThis is cycle ${cycle} — your previous fix did not satisfy the reviewer(s). Read the new findings carefully and adjust.\n`
      : ``,
    `=== REVIEW FEEDBACK ===`,
    reviewComment,
    `=== END REVIEW FEEDBACK ===`,
    ``,
    `For each item:`,
    `  1. Classify it: in-scope-fix, in-scope-accept-with-justification, NOT-APPLICABLE, false-positive, or OUT-OF-SCOPE.`,
    `  2. In-scope-fix: apply the change in the worktree.`,
    `  3. In-scope-accept-with-justification: do nothing in code, but record your reasoning`,
    `     in the commit message of the next commit you make.`,
    `  4. NOT-APPLICABLE (e.g. reviewer suggests mypy --strict but project uses Astral ty;`,
    `     reviewer suggests pytest pattern that doesn't fit the test framework in use): explicitly`,
    `     reason about *why* it's not applicable, in the commit message or PR thread reply. Do`,
    `     NOT silently skip — silent skips are how Forge gets a reputation for ignoring feedback.`,
    `     If you make NO commits at all this cycle (because every item is NOT-APPLICABLE /`,
    `     accept-with-justification / false-positive / OUT-OF-SCOPE), reply on the PR thread`,
    `     summarizing your decisions so the audit trail is visible to a human reader.`,
    `  5. False-positive: do nothing in code, but record reasoning in the commit message.`,
    `  6. OUT-OF-SCOPE: do NOT change code. Instead:`,
    `       a. Reply on the PR thread for that comment using \`gh pr comment ${prNumber} --repo ${repoConfig.repoOwner}/${repoConfig.repoName} --body "Captured as follow-up — out of scope for this PR."\``,
    `          (or per-line via \`gh api\` if the original comment was inline).`,
    `       b. Run \`node /opt/nexus/core/pipeline-worker/dist/cli/queue-add.js --title "<short description>" --body "<full context including the comment author and what they asked for>" --source-pr "${prNumber}" --reason "out-of-scope review item"\``,
    `          to enqueue it as a follow-up task. Output the task id in the commit message of the next commit so it's traceable.`,
    ``,
    `Scope rules:`,
    `  - "In scope" = anything covered by the original ticket title, description, or acceptance criteria,`,
    `    OR a direct correctness/security/tests issue with the code this PR introduced.`,
    `  - "Out of scope" = a request to refactor unrelated code, add a feature not in the ticket, change`,
    `    architecture beyond the ticket, or anything that would substantially expand the diff. When in`,
    `    doubt, prefer OUT-OF-SCOPE: queueing as follow-up is recoverable; merging a sprawled PR isn't.`,
    ``,
    `Constraints:`,
    `  - Match the existing project style. Follow CLAUDE.md.`,
    `  - Group related fixes into one commit when sensible. Multiple commits are acceptable.`,
    `  - Push your commits to origin/${branchName} before exiting.`,
    `  - DO NOT make empty/no-op commits. Empty commits add noise to git history`,
    `    and signal "we did work" when in fact we didn't. If after classifying`,
    `    every finding you have nothing to fix in code (all items are`,
    `    accept-with-justification, false-positive, or out-of-scope-and-queued),`,
    `    exit WITHOUT making any commit and WITHOUT pushing. The audit trail`,
    `    lives in your session transcript and any PR-thread replies you posted.`,
    `    The workflow detects zero new commits and treats that as "review`,
    `    feedback fully resolved without code changes" — proceeds to merge.`,
    ``,
    `Exit immediately after pushing (or, if no commits were made, exit`,
    `immediately after replying on PR threads / queueing follow-ups).`,
  ].join('\n');

  const ccResult = await runCCSessionStreamed({
    worktreePath,
    ticketId: ticket.id,
    repoName: repoConfig.repoName,
    maxTurns: CC_PHASE_CONFIG['address-review'].maxTurns,
    timeoutMs: CC_PHASE_CONFIG['address-review'].timeoutMs,
    initialMessage: message,
    sessionPhase: 'address-review',
    onLine: (rawJsonLine) => {
      let parsed: unknown = rawJsonLine;
      let kind = 'unknown';
      try {
        const obj = JSON.parse(rawJsonLine) as { type?: string };
        parsed = obj;
        if (typeof obj.type === 'string') kind = obj.type;
      } catch {
        kind = 'unparseable';
      }
      void emitEvent({
        workflowId,
        ticketId: ticket.id,
        phase: 'address-review',
        activityId,
        ts: new Date().toISOString(),
        kind,
        payload: parsed,
      });
    },
  });

  // Count new commits on top of preHead. Zero is allowed and meaningful
  // (see activity docstring) — it signals "review feedback fully
  // resolved without code changes."
  const newCommitsResult = spawnSync(
    'git',
    ['-C', worktreePath, 'rev-list', '--count', `${preHead}..HEAD`],
    { encoding: 'utf-8' },
  );
  const newCommitCount = parseInt((newCommitsResult.stdout ?? '0').trim(), 10) || 0;

  if (newCommitCount === 0) {
    // No code changes → no push, no re-CI. Return preHead as the
    // (unchanged) head sha. Workflow will break out of the review loop.
    return { headSha: preHead, newCommitCount: 0, sessionJsonlPath: ccResult.sessionJsonlPath };
  }

  // Push to origin so the PR head advances and CI re-runs. Use
  // `--force-with-lease` so a divergent remote (e.g. a manual fixup
  // commit DK pushed mid-cycle) reports clean failure rather than
  // an unhelpful non-fast-forward.
  const pushResult = spawnSync(
    'git',
    ['-C', worktreePath, 'push', '--force-with-lease', 'origin', `HEAD:${branchName}`],
    { encoding: 'utf-8' },
  );
  if (pushResult.status !== 0) {
    const stderr = ((pushResult.stderr ?? '') + (pushResult.stdout ?? ''))
      .trim().split('\n').slice(-3).join(' | ').slice(0, 400);
    throw ApplicationFailure.nonRetryable(
      `addressReview cycle ${cycle}: git push failed for branch ${branchName}: ${stderr}`,
      'ADDRESS_REVIEW_PUSH_FAILED',
    );
  }

  // Read the new HEAD sha (post-push) so the workflow can rerun CI against it.
  const postHeadResult = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  });
  if (postHeadResult.status !== 0) {
    throw ApplicationFailure.nonRetryable(
      `addressReview cycle ${cycle}: failed to read HEAD after push: ${postHeadResult.stderr}`,
      'ADDRESS_REVIEW_POST_HEAD_READ_FAILED',
    );
  }
  return { headSha: postHeadResult.stdout.trim(), newCommitCount, sessionJsonlPath: ccResult.sessionJsonlPath };
}
