import {
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  proxyActivities,
  executeChild,
  log,
  workflowInfo,
  CancelledFailure,
  isCancellation,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import type { WavePlan, WorkflowOptions } from '../types';
import { slugify } from '../lib/slug';
import { pipelineWorkflow } from './PipelineWorkflow';

// Module-scope signal — must never be defined inside a handler or function body.
export const planApprovedSignal = defineSignal('planApprovedSignal');

// Module-scope query — exposes the wave plan to the Forge Console UI so the
// operator can review what they're approving before clicking approve.
export const currentPlanQuery = defineQuery<WavePlan | null>('currentPlanQuery');

/**
 * Workflow-launch options snapshot. Mirrors the same-named query on
 * `pipelineWorkflow`. Surfaced separately on the parent so the dashboard
 * can render the launch-time choice (e.g. skipProdDeploy) before any
 * children spawn.
 */
export const currentOptionsQuery = defineQuery<WorkflowOptions>('currentOptionsQuery');

const { createLinearTickets } = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },
});

// Best-effort Slack pings: tighter timeout, fewer retries, NEVER throws
// out of the activity (returns {ok:false}). Failures are observability-only.
const slackActs = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 2, initialInterval: '2s', backoffCoefficient: 2 },
});

/**
 * Orchestrates a multi-wave pipeline execution.
 *
 * Flow:
 *   1. Slack-ping the operator with the plan summary + dashboard link.
 *   2. Block until an operator sends `planApprovedSignal` (or cancels).
 *   3. Create all Linear tickets described by the wave plan.
 *   4. For each wave, launch one child `pipelineWorkflow` per ticket in
 *      parallel and wait for every child in the wave to complete before
 *      starting the next wave.
 *
 * Cancellation: operator clicking "reject" on the dashboard issues
 * `handle.cancel(reason)`. That trips the `condition()` await with a
 * `CancelledFailure`, the catch below handles it cleanly, and Temporal
 * records status=CANCELLED rather than FAILED. Reject is a valid
 * operator outcome, not a workflow error.
 */
export async function multiTicketWorkflow(
  wavePlan: WavePlan,
  options: WorkflowOptions = {},
): Promise<void> {
  let planApproved = false;

  setHandler(planApprovedSignal, () => {
    planApproved = true;
  });

  setHandler(currentPlanQuery, () => wavePlan);
  setHandler(currentOptionsQuery, () => ({ ...options }));

  const totalTickets = wavePlan.waves.reduce(
    (sum, wave) => sum + wave.tickets.length,
    0,
  );

  log.info('MultiTicketWorkflow started — awaiting plan approval', {
    waves: wavePlan.waves.length,
    totalTickets,
  });

  // Slack ping — DK should know there's a plan waiting without watching
  // the dashboard. Best-effort: failures logged in the activity, never
  // propagated. Includes the plan instruction + ticket count so DK can
  // judge whether to approve from Slack or open the console for the
  // full per-ticket detail.
  await slackActs.notifySlackActivity({
    text: [
      `🔥 *Forge plan awaiting approval*`,
      ``,
      `Waves: ${wavePlan.waves.length} · Tickets: ${totalTickets}`,
      ``,
      `*Instruction:*`,
      '> ' + wavePlan.instruction.split('\n').slice(0, 4).join('\n> '),
      ``,
      `Approve or reject from the Forge dashboard.`,
    ].join('\n'),
  });

  try {
    await condition(() => planApproved);
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) {
      log.info('MultiTicketWorkflow cancelled before approval');
      // Don't await further activity calls in a cancellation cleanup —
      // CancellationScope swallows them. Just return; Temporal records
      // status=CANCELLED.
      return;
    }
    throw err;
  }

  log.info('Plan approved — creating Linear tickets', {
    waves: wavePlan.waves.length,
    totalTickets,
  });
  await slackActs.notifySlackActivity({
    text: `✅ Forge plan approved — creating ${totalTickets} Linear ticket(s) across ${wavePlan.waves.length} wave(s)`,
  });

  await createLinearTickets(wavePlan);

  log.info('Linear tickets created — beginning wave execution');

  // Descriptive child workflow IDs: `pipeline-<slug>-<parent-ts>-<idx>`.
  // The slug describes the ticket so the dashboard headline is meaningful;
  // parent's startTime + a global ticket index keeps the ID unique even
  // when two tickets in the same plan have similar titles. parentTs is
  // deterministic (workflowInfo().startTime is recorded on workflow start).
  const parentTs = workflowInfo().startTime?.getTime() ?? 0;
  let globalTicketIdx = 0;

  try {
    for (const wave of wavePlan.waves) {
      log.info('Starting wave', {
        wave: wave.wave,
        ticketCount: wave.tickets.length,
        ticketIds: wave.tickets.map((t) => t.id),
      });

      await Promise.all(
        wave.tickets.map((ticket) => {
          // Prefer the ticket title (concise) over description (long-form)
          // for the slug. Falls back to ticket id if title is empty so we
          // always produce a usable slug.
          const slug = slugify(ticket.title || ticket.description || ticket.id, 40);
          const childWorkflowId = `pipeline-${slug}-${parentTs}-${globalTicketIdx++}`;
          // Forward the parent's launch-time options to every child so a
          // skipProdDeploy=true at the parent level applies to every
          // ticket in the plan. planCritique stays empty here — the
          // child runs its own planReviewActivity at IMPLEMENT.
          return executeChild(pipelineWorkflow, {
            args: [ticket, '', options],
            workflowId: childWorkflowId,
            taskQueue: 'forge-pipeline',
          });
        }),
      );

      log.info('Completed wave', {
        wave: wave.wave,
        ticketCount: wave.tickets.length,
      });
    }
  } catch (err) {
    if (isCancellation(err) || err instanceof CancelledFailure) {
      log.info('MultiTicketWorkflow cancelled during wave execution');
      return;
    }
    // A child pipelineWorkflow failed. Slack the parent failure so DK
    // sees the rollup status without having to expand each child.
    // Re-throw so Temporal records FAILED — the parent really did fail.
    //
    // Surface the DEEPEST `cause.message` rather than the wrapper's. The
    // Temporal client wraps activity throws in ChildWorkflowFailure →
    // ActivityFailure → ApplicationFailure layers; each level's
    // `.message` is just `"Activity task failed"` etc. Walking the
    // cause chain gets us to the actual error string the activity
    // raised (e.g. `git push failed for branch forge/tkt-001 [non-fast-forward]: ! [rejected] HEAD -> ...`).
    // Mirrors `formatWorkflowFailure` in forge-console/src/routes/workflows.ts.
    const rootMsg = deepestCauseMessage(err);
    log.error('MultiTicketWorkflow child failed', { error: rootMsg });
    await slackActs.notifySlackActivity({
      text: [
        `🔥 *Forge plan FAILED*`,
        ``,
        `One or more child pipelines did not complete. Check the Forge dashboard for the per-ticket status.`,
        ``,
        `Root cause: ${rootMsg.slice(0, 800)}`,
      ].join('\n'),
    });
    throw err;
  }

  log.info('MultiTicketWorkflow completed — all waves succeeded', {
    waves: wavePlan.waves.length,
    totalTickets,
  });

  await slackActs.notifySlackActivity({
    text: `🔥 Forge plan complete — ${totalTickets} ticket(s) across ${wavePlan.waves.length} wave(s) all merged.`,
  });
}

/**
 * Walk an Error's `cause` chain and return the deepest non-empty
 * `.message`. Mirrors `formatWorkflowFailure` in
 * forge-console/src/routes/workflows.ts.
 *
 * Why: Temporal wraps activity throws in nested wrappers
 * (ChildWorkflowFailure → ActivityFailure → ApplicationFailure → …).
 * Each wrapper's `.message` is a generic "Activity task failed" / etc.
 * The actually informative string lives at the bottom of the chain.
 *
 * Caps at 10 levels to defend against pathological circular causes.
 */
function deepestCauseMessage(err: unknown): string {
  const seen = new Set<unknown>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cur: any = err;
  let deepest: string | null = null;
  for (let i = 0; i < 10 && cur && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur.message === 'string' && cur.message.trim().length > 0) {
      deepest = cur.message;
    }
    cur = cur.cause;
  }
  if (deepest) return deepest;
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}
