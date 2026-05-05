#!/usr/bin/env node
import { getTemporalClient } from '../temporal-client';
import { planApprovedSignal } from '../workflows/MultiTicketWorkflow';

(async () => {
  const workflowId = process.argv[2];
  if (!workflowId || !workflowId.trim()) {
    throw new Error('Usage: node dist/cli/approve.js <workflowId>');
  }

  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(planApprovedSignal);

  process.stdout.write(
    `Plan approved — workflow ${workflowId} proceeding to IMPLEMENT\n`
  );
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`forge-approve failed: ${msg}\n`);
  process.exit(1);
});
