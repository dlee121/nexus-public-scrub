import {
  proxyActivities,
  sleep,
  continueAsNew,
  log,
  defineQuery,
  setHandler,
} from '@temporalio/workflow';
import type * as activities from '../activities';

/**
 * Patrol workflow: periodically runs a quality patrol CC session over the
 * configured repo, filing Linear issues for drift. It uses `continueAsNew`
 * between cycles so the event history stays small even when the patrol has
 * run for months.
 */

const { runPatrolActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2, initialInterval: '30s', backoffCoefficient: 2 },
});

export interface PatrolStatus {
  lastRun: string | null;
  runCount: number;
}

export const getPatrolStatusQuery = defineQuery<PatrolStatus>('getPatrolStatus');

const PATROL_SLEEP_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function patrolWorkflow(runCount: number = 0): Promise<void> {
  let lastRun: string | null = null;
  setHandler(getPatrolStatusQuery, () => ({ lastRun, runCount }));

  log.info('Patrol cycle starting', { runCount });

  try {
    await runPatrolActivity();
    lastRun = new Date().toISOString();
    log.info('Patrol cycle complete', { runCount, lastRun });
  } catch (err) {
    log.error('Patrol cycle failed', {
      runCount,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Sleep between patrols, then continueAsNew to keep history bounded.
  await sleep(PATROL_SLEEP_MS);
  await continueAsNew<typeof patrolWorkflow>(runCount + 1);
}
