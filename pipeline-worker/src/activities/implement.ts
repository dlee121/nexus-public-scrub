import { spawnSync } from 'child_process';
import { ApplicationFailure } from '@temporalio/common';
import { Context } from '@temporalio/activity';
import { CC_PHASE_CONFIG } from '../lib/cc';
import { runCCSessionStreamed } from '../lib/cc-streamed';
import { emitEvent } from '../lib/event-emit';
import { createWorktree } from '../lib/worktree';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { Ticket } from '../types';

export interface ImplementResult {
  worktreePath: string;
  branchName: string;
  /** Absolute path to the CC session JSONL the implement subprocess wrote, or null if not captured. */
  sessionJsonlPath: string | null;
}

export async function implementActivity(ticket: Ticket, planCritique: string): Promise<ImplementResult> {
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);
  const repoPath = `/opt/nexus/repos/${repoConfig.repoName}`;
  const worktreePath = createWorktree(repoPath, ticket.id, repoConfig.defaultBranch);
  // Branch name carries a 7-digit timestamp suffix so multiple Forge runs
  // against the same ticket id never collide at the remote (which is what
  // killed `forge-fix-ty-baseline-prune-yml-silent-1777581364383` —
  // remote `forge/tkt-001` had stale tip from a prior run, push rejected
  // non-fast-forward, three retries failed identically). 7 digits of
  // millisecond epoch covers ~115 days of uniqueness; plenty.
  // Activities run non-deterministically by design (their result is
  // recorded in workflow history), so Date.now() here is safe.
  const branchSuffix = Date.now().toString().slice(-7);
  const branchName = `forge/${ticket.id.toLowerCase()}-${branchSuffix}`;

  const message = [
    `Implement the following ticket: ${ticket.title}`,
    ``,
    `Description: ${ticket.description}`,
    ``,
    `Acceptance criteria:`,
    ...ticket.acceptanceCriteria.map(c => `- ${c}`),
    planCritique ? `\nPlan critique from code review:\n${planCritique}` : '',
    ``,
    `If your work is investigative/analytical rather than a code change (e.g., running tests, auditing imports, producing a report), commit your findings as FINDINGS.md before exiting. The session is considered successful only if at least one commit is made.`,
  ].join('\n');

  // Resolve workflow context for event tagging. Activities run inside
  // Temporal's activity context, so workflowExecution.workflowId is the
  // PARENT (pipeline-<ticketId>) — exactly what the console keys streams by.
  const ctx = Context.current();
  const workflowId = ctx.info.workflowExecution.workflowId;
  const activityId = ctx.info.activityId;

  const ccResult = await runCCSessionStreamed({
    worktreePath,
    ticketId: ticket.id,
    repoName: repoConfig.repoName,
    maxTurns: CC_PHASE_CONFIG.implement.maxTurns,
    timeoutMs: CC_PHASE_CONFIG.implement.timeoutMs,
    initialMessage: message,
    sessionPhase: 'implement',
    onLine: (rawJsonLine) => {
      // stream-json emits one JSON object per line. Parse opportunistically
      // so the console can render structured payloads; fall back to raw
      // string on malformed lines (defensive — shouldn't happen).
      let parsed: unknown = rawJsonLine;
      let kind = 'unknown';
      try {
        const obj = JSON.parse(rawJsonLine) as { type?: string };
        parsed = obj;
        if (typeof obj.type === 'string') kind = obj.type;
      } catch {
        kind = 'unparseable';
      }
      // Fire-and-forget — emitEvent never throws and never awaits anything
      // the activity should block on. Keep onLine synchronous.
      void emitEvent({
        workflowId,
        ticketId: ticket.id,
        phase: 'implement',
        activityId,
        ts: new Date().toISOString(),
        kind,
        payload: parsed,
      });
    },
  });

  // Validate that the CC session actually produced commits.
  const postSessionCommits = spawnSync(
    'git',
    ['-C', worktreePath, 'rev-list', '--count', 'origin/main..HEAD'],
    { encoding: 'utf-8' },
  );
  if ((postSessionCommits.stdout ?? '').trim() === '0') {
    throw ApplicationFailure.nonRetryable('IMPLEMENT produced no commits — Claude Code session made no changes');
  }

  return { worktreePath, branchName, sessionJsonlPath: ccResult.sessionJsonlPath };
}
