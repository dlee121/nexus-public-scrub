/**
 * Smoke check — verifies the console can:
 *   1. Read all required env vars
 *   2. Connect to Temporal Cloud over mTLS
 *   3. Issue a workflow.list query (the exact call /api/workflows depends on)
 *
 * Does NOT bind a port or start the server. Safe to run anytime.
 *
 * Usage:
 *   bash -c 'source forge-console/load-env.sh && cd forge-console && bun run smoke'
 */

import { getTemporalClient, getNamespace } from './temporal.ts';

async function main(): Promise<void> {
  console.log('[smoke] namespace:', getNamespace());
  console.log('[smoke] connecting to Temporal Cloud…');
  const client = await getTemporalClient();
  console.log('[smoke] ✓ connected');

  console.log('[smoke] listing workflows on forge-pipeline (capped at 5)…');
  let count = 0;
  for await (const exec of client.workflow.list({
    query: 'TaskQueue="forge-pipeline"',
  })) {
    console.log(`  - ${exec.workflowId} (${exec.status.name})`);
    if (++count >= 5) break;
  }
  console.log(`[smoke] ✓ list query returned ${count} workflow(s)`);

  console.log('[smoke] all checks passed.');
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[smoke] FAILED: ${msg}\n`);
  process.exit(1);
});
