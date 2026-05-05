#!/usr/bin/env node
import { getTemporalClient } from '../temporal-client';

(async () => {
  const workflowId = process.argv[2];
  const signalName = process.argv[3];
  const payloadArg = process.argv[4];

  if (!workflowId || !workflowId.trim()) {
    throw new Error(
      'Usage: node dist/cli/signal.js <workflowId> <signalName> [jsonPayload]'
    );
  }
  if (!signalName || !signalName.trim()) {
    throw new Error(
      'Usage: node dist/cli/signal.js <workflowId> <signalName> [jsonPayload]'
    );
  }

  let payload: unknown = undefined;
  if (payloadArg !== undefined) {
    try {
      payload = JSON.parse(payloadArg);
    } catch (err) {
      throw new Error(
        `Payload is not valid JSON: ${(err as Error).message}`
      );
    }
  }

  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  if (payload === undefined) {
    await handle.signal(signalName);
  } else {
    await handle.signal(signalName, payload);
  }

  const suffix =
    payload === undefined ? '' : ` with payload ${JSON.stringify(payload)}`;
  process.stdout.write(
    `Sent signal "${signalName}" to workflow ${workflowId}${suffix}\n`
  );
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`forge-signal failed: ${msg}\n`);
  process.exit(1);
});
