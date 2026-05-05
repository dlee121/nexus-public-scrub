import { Hono, type Context } from 'hono';
import { getTemporalClient } from '../temporal.ts';
import type { ActionResponse } from '../types.ts';

export const actionsRoutes = new Hono();

/**
 * Approve a plan — sends planApprovedSignal to a multiTicketWorkflow.
 * Idempotent: signaling an already-approved workflow is a no-op (the
 * planApproved boolean inside the workflow is just set true again).
 */
actionsRoutes.post('/:id/approve', async (c) => {
  const workflowId = c.req.param('id');
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  try {
    await handle.signal('planApprovedSignal');
    const body: ActionResponse = {
      ok: true,
      workflowId,
      signal: 'planApprovedSignal',
    };
    return c.json(body);
  } catch (err) {
    const body: ActionResponse = {
      ok: false,
      workflowId,
      error: err instanceof Error ? err.message : String(err),
    };
    return c.json(body, 500);
  }
});

/**
 * Reject a plan — sends a graceful CANCEL to the workflow.
 *
 * Why cancel and not terminate: the operator's intent is "I don't want
 * this work to run", not "kill this thing forcefully". Cancel gives the
 * workflow a chance to catch CancelledFailure, do cleanup, and return —
 * Temporal records status=CANCELLED, which the dashboard classifier
 * routes into the (eventual) cancelled bucket. Terminate yields
 * status=TERMINATED, which the Temporal UI renders with a red icon
 * indistinguishable from FAILED — exactly the misclassification this
 * change fixes.
 *
 * `closeWorkflowSignal` is sent first as a best-effort cooperative
 * heads-up for workflows that register it. Then we cancel.
 */
actionsRoutes.post('/:id/reject', async (c) => {
  const workflowId = c.req.param('id');
  let reason = 'Rejected via Forge Console';
  try {
    const body = await c.req.json<{ reason?: string }>();
    if (body.reason && body.reason.trim()) reason = body.reason.trim();
  } catch {
    // No body / not JSON — use default reason.
  }
  return await cancelWorkflow(c, workflowId, reason, 'rejected');
});

/**
 * Close a workflow — operator-initiated cleanup of a stuck or
 * unwanted run. Same semantics as /reject (CANCEL, not TERMINATE).
 * Different copy on the UI; same wire intent. Reserved for the
 * "this thing is just stuck, kill it cleanly" case.
 */
actionsRoutes.post('/:id/close', async (c) => {
  const workflowId = c.req.param('id');
  return await cancelWorkflow(c, workflowId, 'Closed via Forge Console', 'closed');
});

/**
 * Approve a prod deploy — sends prodApprovedSignal to a pipelineWorkflow
 * sitting at the PROD_DEPLOY_GATE state. Idempotent.
 */
actionsRoutes.post('/:id/prod-approve', async (c) => {
  const workflowId = c.req.param('id');
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  try {
    await handle.signal('prodApprovedSignal');
    const body: ActionResponse = { ok: true, workflowId, signal: 'prodApprovedSignal' };
    return c.json(body);
  } catch (err) {
    const body: ActionResponse = {
      ok: false, workflowId,
      error: err instanceof Error ? err.message : String(err),
    };
    return c.json(body, 500);
  }
});

/**
 * Reject a prod deploy — sends prodRejectedSignal. The workflow ends
 * cleanly with state=DONE (dev deploy stays). Distinct from /reject
 * which CANCELs the whole workflow; this is "I'm fine with dev, skip
 * prod" — a successful outcome.
 */
actionsRoutes.post('/:id/prod-reject', async (c) => {
  const workflowId = c.req.param('id');
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  try {
    await handle.signal('prodRejectedSignal');
    const body: ActionResponse = { ok: true, workflowId, signal: 'prodRejectedSignal' };
    return c.json(body);
  } catch (err) {
    const body: ActionResponse = {
      ok: false, workflowId,
      error: err instanceof Error ? err.message : String(err),
    };
    return c.json(body, 500);
  }
});

async function cancelWorkflow(
  c: Context,
  workflowId: string,
  _reason: string,
  action: 'rejected' | 'closed',
) {
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  // Best-effort cooperative shutdown signal first. If the workflow
  // defines closeWorkflowSignal it can clean up before the cancel
  // arrives. If not, the signal call throws and we ignore.
  try {
    await handle.signal('closeWorkflowSignal');
  } catch {
    // Signal handler not registered — fine, continue to cancel.
  }

  try {
    // cancel() takes no reason argument in @temporalio/client; the
    // CancelledFailure surfaced inside the workflow carries no
    // operator-supplied message. The reason is logged here only.
    await handle.cancel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Already completed" / "not found" / "closed" — treat as success;
    // the desired terminal state is already reached.
    if (!/not found|already completed|closed/i.test(msg)) {
      const body: ActionResponse = { ok: false, workflowId, error: msg };
      return c.json(body, 500);
    }
  }

  const body: ActionResponse = { ok: true, workflowId, action };
  return c.json(body);
}
