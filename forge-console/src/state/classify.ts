// PipelineState is duplicated locally rather than imported from pipeline-worker
// to keep this package free of cross-package source imports. If a state name
// changes there, mirror it here and bump tests.

// PENDING — waiting on a human gate. PROD_DEPLOY_GATE is added in the
// post-merge deploy automation work; the others are pre-existing.
const NEEDS_APPROVAL_STATES: ReadonlySet<string> = new Set([
  'PLANNING',
  'PLAN_REVIEW',
  'APPROVAL_WAIT',
  'PROD_DEPLOY_GATE',
]);

// COMPLETED — terminal success. CANCELLED counts here: operator
// explicitly chose to stop (via /reject or /close), the workflow caught
// the CancelledFailure and returned cleanly. Not a failure.
const DONE_STATES: ReadonlySet<string> = new Set([
  'DONE',
  'CANCELLED',
]);
const TEMPORAL_DONE_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'CANCELLED',
]);

// FAILED — terminal failure. BLOCKED is the app-level "I had to stop
// and need a human" (uncaught throw inside the workflow). FAILED is the
// catch-all. Temporal-level: TERMINATED (forced kill, rare/operator
// nuke) and TIMED_OUT (workflow timeout). CANCELLED moved out of here
// to DONE — a graceful cancel is not a failure.
const FAILED_STATES: ReadonlySet<string> = new Set([
  'BLOCKED',
  'FAILED',
]);
const TEMPORAL_FAILED_STATUSES: ReadonlySet<string> = new Set([
  'FAILED',
  'TERMINATED',
  'TIMED_OUT',
]);

/**
 * Bucket = the lifecycle category surfaced in the dashboard:
 *   needsApproval → "PENDING" (awaiting human gate)
 *   running       → "IN_PROGRESS" (Forge is working)
 *   done          → "COMPLETED" (success or graceful cancel)
 *   failed        → "FAILED" (unrecoverable / TERMINATED / TIMED_OUT)
 */
export type Bucket = 'needsApproval' | 'running' | 'done' | 'failed';

export function classifyState(state: string): Bucket {
  if (NEEDS_APPROVAL_STATES.has(state)) return 'needsApproval';
  if (FAILED_STATES.has(state)) return 'failed';
  if (TEMPORAL_FAILED_STATUSES.has(state)) return 'failed';
  if (DONE_STATES.has(state)) return 'done';
  if (TEMPORAL_DONE_STATUSES.has(state)) return 'done';
  return 'running';
}

/**
 * Workflow ID conventions:
 *   - parent (multiTicket) — `forge-<slug>-<ts>` (current) or `forge-<ts>` (legacy)
 *   - child  (pipeline)    — `pipeline-<slug>-<ts>-<idx>` (current),
 *                            `pipeline-<slug>-<ts>` (interim), or
 *                            `pipeline-<ticketId>` (legacy: `pipeline-TKT-001`)
 *
 * `extractTicketId` returns a card-display label. For new pipeline IDs
 * the label is the prettified slug; for legacy IDs (`pipeline-TKT-001`)
 * it returns the ticket id as before. The UI's renderHeadline does the
 * final prettification (hyphen→space, title-case).
 */
export function extractTicketId(workflowId: string): string {
  if (!workflowId.startsWith('pipeline-')) return workflowId;
  const tail = workflowId.slice('pipeline-'.length);
  // Strip a trailing -<10+digit-ts>(-<idx>)? when present — leaves the slug.
  const m = tail.match(/^(.+?)-\d{10,}(?:-\d+)?$/);
  return m && m[1] ? m[1] : tail;
}
