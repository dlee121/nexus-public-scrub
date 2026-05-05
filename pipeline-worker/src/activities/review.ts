import { Octokit } from '@octokit/rest';
import { Context } from '@temporalio/activity';
import { CC_PHASE_CONFIG } from '../lib/cc';
import { runCCSessionStreamed } from '../lib/cc-streamed';
import { emitEvent } from '../lib/event-emit';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { Ticket } from '../types';

export interface ReviewResult {
  /** True when the /review skill posted a "Found N issues" comment. */
  hasIssues: boolean;
  /** Body of the review comment, empty if no comment was posted. */
  commentBody: string;
  /** Comment id used for tracing; -1 when no comment found. */
  commentId: number;
  /** Absolute path to the CC session JSONL the review subprocess wrote, or null if not captured. */
  sessionJsonlPath: string | null;
}

/**
 * Run /review against the PR and return the verdict. Does NOT throw on
 * findings — the workflow drives the bounded REVIEW → ADDRESS_REVIEW
 * → re-CI loop and decides when to give up. This activity is pure
 * inspection.
 *
 * The skill itself runs an eligibility check, fans out to Haiku+Sonnet
 * sub-agents, scores findings, filters at >=80 confidence, and posts
 * one of two comment shapes:
 *
 *   "### Code review\n\nFound N issues:\n..."
 *   "### Code review\n\nNo issues found. Checked for bugs and CLAUDE.md compliance."
 *
 * Outcome mapping:
 *   - "Found N issues" comment posted              → hasIssues: true
 *   - "No issues found" comment posted             → hasIssues: false
 *   - No comment posted (eligibility short-circuit
 *     for closed/draft/already-reviewed/automated) → hasIssues: false
 */
export async function reviewActivity(params: {
  ticket: Ticket;
  prNumber: number;
  worktreePath: string;
}): Promise<ReviewResult> {
  const { ticket, prNumber, worktreePath } = params;
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);

  const ctx = Context.current();
  const workflowId = ctx.info.workflowExecution.workflowId;
  const activityId = ctx.info.activityId;

  const message = [
    `Run /review ${prNumber} for repository ${repoConfig.repoOwner}/${repoConfig.repoName}.`,
    ``,
    `Follow the /review skill exactly as documented. Post the resulting comment to the PR via gh. Do not perform any code changes — review only.`,
    ``,
    `When the skill finishes (with either "Found N issues" or "No issues found" comment posted, or with an early-exit decision that the PR is ineligible for review), exit immediately.`,
  ].join('\n');

  const ccResult = await runCCSessionStreamed({
    worktreePath,
    ticketId: ticket.id,
    repoName: repoConfig.repoName,
    maxTurns: CC_PHASE_CONFIG.review.maxTurns,
    timeoutMs: CC_PHASE_CONFIG.review.timeoutMs,
    initialMessage: message,
    sessionPhase: 'review',
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
        phase: 'review',
        activityId,
        ts: new Date().toISOString(),
        kind,
        payload: parsed,
      });
    },
  });

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set in reviewActivity');
  const octokit = new Octokit({ auth: token });

  const { data: comments } = await octokit.rest.issues.listComments({
    owner: repoConfig.repoOwner,
    repo: repoConfig.repoName,
    issue_number: prNumber,
    per_page: 100,
  });

  const reviewComment = [...comments]
    .reverse()
    .find((c) => typeof c.body === 'string' && c.body.includes('### Code review'));

  if (!reviewComment || !reviewComment.body) {
    // Skill exited without posting — most likely the eligibility check
    // (closed/draft/already-reviewed/automated PR) short-circuited it.
    // Treat as clean: nothing to gate on.
    return { hasIssues: false, commentBody: '', commentId: -1, sessionJsonlPath: ccResult.sessionJsonlPath };
  }

  const body = reviewComment.body;
  const hasFindings = /Found\s+\d+\s+issue/i.test(body);
  const isClean = /No issues found\b/i.test(body);

  return {
    hasIssues: hasFindings && !isClean,
    commentBody: body,
    commentId: reviewComment.id,
    sessionJsonlPath: ccResult.sessionJsonlPath,
  };
}
