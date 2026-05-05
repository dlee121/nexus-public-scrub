#!/usr/bin/env node
/**
 * Forge e2e probe — kicks off a known-bounded cleanup task against
 * [target-repo-realtime] to verify the full pipeline (plan → review →
 * implement → verify → PR_OPEN → CI → merge) is healthy end-to-end.
 *
 * Usage:
 *   npm run e2e                     # default: cleanup-the-stale-policy-TODO
 *   npm run e2e -- "<instruction>"  # override with any free-text instruction
 *
 * What it does:
 *   1. Calls generateWavePlan() on the instruction (real GPT-4.1 call).
 *   2. Starts multiTicketWorkflow on Temporal Cloud with workflowId
 *      `forge-e2e-<ts>` (the e2e- prefix lets you filter probe runs from
 *      regular forge-* runs in workflow searches).
 *   3. Verifies the workflow is RUNNING (not failed-on-start).
 *   4. Prints operator next-steps: how to approve, how to watch.
 *
 * What it does NOT do:
 *   - Wait through the full ~25 min pipeline. Use `bun run src/cli/list.ts`
 *     for monitoring; the existing dashboard at src/dashboard/server.ts also
 *     surfaces all running forge-* workflows.
 *   - Auto-approve. Plan review is an operator-judgment gate by design.
 *   - Re-run automatically. The default cleanup target is one-shot — once the
 *     stale TODO is removed by a successful run, subsequent default runs will
 *     either fail (no commits — guard added in commit 85a7d3e) or pick a
 *     different target. Re-run with a fresh custom instruction or restore
 *     the TODO before re-running.
 *
 * Expected success outcome: a PR opens on [org]/[target-repo-realtime]
 * deleting the stale TODO at src/trigger_engine/policy.py:81-83.
 */

import { getTemporalClient } from '../temporal-client';
import { multiTicketWorkflow } from '../workflows/MultiTicketWorkflow';
import { config } from '../config';
import { generateWavePlan } from './plan';

const DEFAULT_INSTRUCTION = `
Remove the stale "TODO: Implement org override hook" comment block from
src/trigger_engine/policy.py in the [target-repo-realtime] repository.
Context: the TODO comment sits immediately above a call to
_fetch_org_overrides which already implements the override functionality
the TODO refers to. The comment is misleading and represents work that's
already done.

Acceptance:
- The three-line TODO/comment block (around lines 81-83) is removed
- No other code is changed; the diff is the comment removal only
- No functional behavior change
- Existing tests pass
`.trim();

async function main(): Promise<void> {
  const namespace = process.env.TEMPORAL_NAMESPACE;
  if (!namespace) {
    throw new Error('TEMPORAL_NAMESPACE env var is required (source load-env.sh first)');
  }

  const instruction = (process.argv[2] && process.argv[2].trim()) || DEFAULT_INSTRUCTION;
  const usingDefault = instruction === DEFAULT_INSTRUCTION;

  console.log('[e2e-probe] Instruction:', usingDefault ? '(default cleanup)' : '(custom)');
  console.log('[e2e-probe] Generating wave plan via GPT-4.1...');

  const wavePlan = await generateWavePlan(instruction);
  const totalTickets = wavePlan.waves.reduce((sum, w) => sum + w.tickets.length, 0);
  console.log(
    `[e2e-probe] Plan generated: ${wavePlan.waves.length} wave(s), ${totalTickets} ticket(s)`
  );
  for (const wave of wavePlan.waves) {
    console.log(`  Wave ${wave.wave}:`);
    for (const t of wave.tickets) {
      console.log(`    - ${t.id}: ${t.title}`);
    }
  }

  const client = await getTemporalClient();
  const workflowId = `forge-e2e-${Date.now()}`;

  console.log(`\n[e2e-probe] Starting workflow ${workflowId} on task queue ${config.pipeline.taskQueue}...`);

  const handle = await client.workflow.start(multiTicketWorkflow, {
    args: [wavePlan],
    taskQueue: config.pipeline.taskQueue,
    workflowId,
  });

  // Confirm the workflow actually entered RUNNING state — catches misroutings,
  // task-queue misconfigs, or worker-down scenarios where start() succeeds at
  // the API level but the workflow never gets picked up.
  const desc = await handle.describe();
  if (desc.status.name !== 'RUNNING') {
    throw new Error(
      `Workflow accepted by Temporal but status is ${desc.status.name} (expected RUNNING). ` +
        `Likely no worker on task queue "${config.pipeline.taskQueue}".`
    );
  }

  const temporalUrl = `https://cloud.temporal.io/namespaces/${namespace}/workflows/${workflowId}`;

  console.log(`\n[e2e-probe] ✓ Workflow live, awaiting planApprovedSignal`);
  console.log(`\n  Workflow ID:  ${workflowId}`);
  console.log(`  Temporal URL: ${temporalUrl}`);
  console.log(`\n[e2e-probe] Next steps:`);
  console.log(`  1. Review the wave plan printed above.`);
  console.log(`  2. Approve to proceed:`);
  console.log(`     bun run src/cli/approve.ts ${workflowId}`);
  console.log(`  3. Watch progress (parent + children):`);
  console.log(`     bun run src/cli/list.ts`);
  console.log(`     # or open the dashboard at http://127.0.0.1:4640`);
  console.log(`  4. Expected success: a PR on [org]/[target-repo-realtime]`);
  console.log(`     deleting the stale TODO at src/trigger_engine/policy.py:81-83.`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`forge-e2e-probe failed: ${msg}\n`);
  process.exit(1);
});
