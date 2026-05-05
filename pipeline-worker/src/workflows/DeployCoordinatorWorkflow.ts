import {
  setHandler,
  condition,
  proxyActivities,
  defineSignal,
  defineQuery,
  sleep,
  log,
  getExternalWorkflowHandle,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { DeployedVersion } from '../types';

export interface DeployTicket {
  ticketId: string;
  mergeSha: string;
  enqueuedAt: number;
}

export interface DeployCompletedPayload {
  status: 'success' | 'failure';
  version?: DeployedVersion;
  error?: string;
}

// Module-scope signal/query definitions
export const enqueueDeploySignal = defineSignal<[DeployTicket]>('enqueueDeploySignal');
export const getDeployedVersionQuery = defineQuery<DeployedVersion | null>('getDeployedVersion');

// `runDeployActivity` heartbeats every 30s (see activities/runDeploy.ts).
// `heartbeatTimeout` is set so a hung deploy fails fast rather than burning
// the full 60 min startToClose. 90s = "one missed beat tolerated, two
// trips the timeout" — same posture as PipelineWorkflow's deployActs.
// Other activities under this proxy (devDeploy, getLatestOriginMain,
// checkAncestry, isAutoDeployRepo) don't heartbeat, but that's fine —
// `heartbeatTimeout` is only enforced when the activity heartbeats at
// least once. Non-heartbeating activities still rely on startToClose.
const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 minutes',
  heartbeatTimeout: '90 seconds',
});

interface PartitionResult {
  covered: DeployTicket[];
  requeued: DeployTicket[];
  winnerTicket: DeployTicket | undefined;
}

async function partitionQueue(
  queue: DeployTicket[],
  originMainSha: string
): Promise<PartitionResult> {
  const covered: DeployTicket[] = [];
  const requeued: DeployTicket[] = [];

  for (const ticket of queue) {
    if (ticket.mergeSha === originMainSha) {
      // Exact match — winner, handled below
      covered.push(ticket);
      continue;
    }
    const isAncestor = await acts.checkAncestryActivity(ticket.mergeSha, originMainSha);
    if (isAncestor) {
      covered.push(ticket);
    } else {
      requeued.push(ticket);
    }
  }

  const winnerTicket =
    queue.find((t) => t.mergeSha === originMainSha) ?? covered[covered.length - 1];

  const coveredWithoutWinner = winnerTicket
    ? covered.filter((t) => t !== winnerTicket)
    : covered;

  return { covered: coveredWithoutWinner, requeued, winnerTicket };
}

export async function deployCoordinatorWorkflow(env: 'dev' | 'prod'): Promise<void> {
  let queue: DeployTicket[] = [];
  let running = false;
  let lastDeployedVersion: DeployedVersion | null = null;

  setHandler(enqueueDeploySignal, (ticket: DeployTicket) => {
    queue.push(ticket);
  });
  setHandler(getDeployedVersionQuery, () => lastDeployedVersion);

  while (true) {
    await condition(() => queue.length > 0 && !running);

    let originMainSha = await acts.getLatestOriginMainActivity();
    let partition = await partitionQueue(queue, originMainSha);
    let coveredTickets = partition.covered;
    let requeuedTickets = partition.requeued;
    let winnerTicket = partition.winnerTicket;

    // v9 FIX 1: Empty partition retry loop — if queue has tickets but none
    // map to origin/main (not covered, not winner), retry up to 3 times with
    // fresh fetches. On success, MUST update originMainSha before proceeding.
    if (!winnerTicket && coveredTickets.length === 0) {
      let resolved = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        log.info('Empty partition — retrying fetch', {
          env,
          attempt,
          queueSize: queue.length,
        });
        await sleep(5000);
        const retryOriginMainSha = await acts.getLatestOriginMainActivity();
        const retryPartition = await partitionQueue(queue, retryOriginMainSha);
        if (retryPartition.winnerTicket || retryPartition.covered.length > 0) {
          originMainSha = retryOriginMainSha;
          coveredTickets = retryPartition.covered;
          requeuedTickets = retryPartition.requeued;
          winnerTicket = retryPartition.winnerTicket;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        log.error('INVARIANT_VIOLATION: queue non-empty but no tickets map to origin/main', {
          env,
          queueSize: queue.length,
          originMainSha,
        });
        for (const ticket of queue) {
          const handle = getExternalWorkflowHandle(ticket.ticketId);
          try {
            await handle.signal('deployFailedSignal', {
              error: `INVARIANT_VIOLATION: ticket ${ticket.ticketId} (sha=${ticket.mergeSha}) did not map to origin/main after 3 retries`,
            });
          } catch (signalErr) {
            log.warn('Failed to signal deployFailedSignal for invariant violation', {
              ticketId: ticket.ticketId,
              error: (signalErr as Error).message,
            });
          }
        }
        queue = [];
        continue;
      }
    }

    queue = requeuedTickets;
    running = true;

    // Signal covered (non-winner) tickets that they are coalesced
    for (const covered of coveredTickets) {
      if (!winnerTicket) break;
      const handle = getExternalWorkflowHandle(covered.ticketId);
      try {
        await handle.signal('coveredByCoalesceSignal', {
          coveringTicketId: winnerTicket.ticketId,
          coveringMergeSha: originMainSha,
          note: `Coalesced into ${winnerTicket.ticketId} (${originMainSha.slice(0, 12)})`,
        });
      } catch (signalErr) {
        log.warn('Failed to signal coveredByCoalesceSignal', {
          ticketId: covered.ticketId,
          error: (signalErr as Error).message,
        });
      }
    }

    if (!winnerTicket) {
      // Should be unreachable given the retry-loop guard above, but handle defensively
      running = false;
      continue;
    }

    try {
      log.info('Starting deploy', {
        env,
        winnerTicketId: winnerTicket.ticketId,
        originMainSha,
        coveredCount: coveredTickets.length,
      });

      const version = await acts.runDeployActivity(env, {
        ticketId: winnerTicket.ticketId,
        mergeSha: originMainSha,
        enqueuedAt: winnerTicket.enqueuedAt,
      });

      lastDeployedVersion = version;

      const successPayload: DeployCompletedPayload = {
        status: 'success',
        version,
      };

      const winnerHandle = getExternalWorkflowHandle(winnerTicket.ticketId);
      try {
        await winnerHandle.signal('deployCompletedSignal', successPayload);
      } catch (signalErr) {
        log.warn('Failed to signal deployCompletedSignal to winner', {
          ticketId: winnerTicket.ticketId,
          error: (signalErr as Error).message,
        });
      }

      for (const covered of coveredTickets) {
        const handle = getExternalWorkflowHandle(covered.ticketId);
        try {
          await handle.signal('deployCompletedSignal', successPayload);
        } catch (signalErr) {
          log.warn('Failed to signal deployCompletedSignal to covered ticket', {
            ticketId: covered.ticketId,
            error: (signalErr as Error).message,
          });
        }
      }

      running = false;
    } catch (err) {
      running = false;
      const errorMessage = (err as Error).message;
      log.error('Deploy failed', {
        env,
        winnerTicketId: winnerTicket.ticketId,
        error: errorMessage,
      });

      const winnerHandle = getExternalWorkflowHandle(winnerTicket.ticketId);
      try {
        await winnerHandle.signal('deployFailedSignal', { error: errorMessage });
      } catch (signalErr) {
        log.warn('Failed to signal deployFailedSignal to winner', {
          ticketId: winnerTicket.ticketId,
          error: (signalErr as Error).message,
        });
      }

      const failurePayload: DeployCompletedPayload = {
        status: 'failure',
        error: errorMessage,
      };
      for (const covered of coveredTickets) {
        const handle = getExternalWorkflowHandle(covered.ticketId);
        try {
          await handle.signal('deployCompletedSignal', failurePayload);
        } catch (signalErr) {
          log.warn('Failed to signal deployCompletedSignal(failure) to covered ticket', {
            ticketId: covered.ticketId,
            error: (signalErr as Error).message,
          });
        }
      }
    }
  }
}
