#!/usr/bin/env node
import { getTemporalClient } from '../temporal-client';

(async () => {
  const client = await getTemporalClient();
  const iterable = client.workflow.list({
    query: 'TaskQueue="forge-pipeline" AND ExecutionStatus="Running"',
  });

  const results: Array<{
    workflowId: string;
    startTime: string;
    status: string;
  }> = [];

  for await (const exec of iterable) {
    results.push({
      workflowId: exec.workflowId,
      startTime: exec.startTime.toISOString(),
      status: exec.status.name,
    });
    if (results.length >= 50) break;
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`forge-list failed: ${msg}\n`);
  process.exit(1);
});
