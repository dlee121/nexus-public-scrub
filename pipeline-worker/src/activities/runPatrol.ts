import { runCCSession, CC_PHASE_CONFIG } from '../lib/cc';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

const PATROL_TICKET_ID = 'patrol-agent';

function patrolPrompt(repoName: string): string {
  return [
    `You are running a quality patrol on ${repoName}.`,
    'Analyze the last 20 merged commits for: type coverage gaps, test coverage gaps,',
    'dependency drift, documentation drift, architecture drift.',
    'For each issue found: create a Linear issue with title, description, and',
    'acceptance criteria. Use labels: patrol, quality-drift. Priority: medium.',
    'Status: Backlog. Escalate to Telegram only for security regressions or broken',
    'public API type contracts.',
  ].join(' ');
}

/**
 * Run a single patrol CC session against the named repo. Throws on any
 * session failure so the workflow's retry policy can handle it.
 */
export async function runPatrolActivity(params?: { repoName?: string }): Promise<void> {
  const repoConfig = getRepoConfig(params?.repoName ?? DEFAULT_REPO_NAME);
  const repoPath = `/opt/nexus/repos/${repoConfig.repoName}`;

  try {
    await runCCSession({
      worktreePath: repoPath,
      ticketId: PATROL_TICKET_ID,
      repoName: repoConfig.repoName,
      maxTurns: CC_PHASE_CONFIG.patrol.maxTurns,
      timeoutMs: CC_PHASE_CONFIG.patrol.timeoutMs,
      initialMessage: patrolPrompt(repoConfig.repoName),
      sessionPhase: 'patrol',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Patrol CC session failed: ${msg}`);
  }
}
