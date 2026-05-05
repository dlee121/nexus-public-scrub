/**
 * Layer 0 BFS spike: verify Bun + @temporalio/client can connect to Temporal Cloud.
 * Run: bun run src/spike.ts
 */

import { Connection } from '@temporalio/client';
import { readFileSync } from 'fs';

const address = process.env.TEMPORAL_ADDRESS;
const namespace = process.env.TEMPORAL_NAMESPACE;
const certPath = process.env.TEMPORAL_TLS_CERT_PATH;
const keyPath = process.env.TEMPORAL_TLS_KEY_PATH;

if (!address || !namespace || !certPath || !keyPath) {
  console.error('Missing required env vars: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_TLS_CERT_PATH, TEMPORAL_TLS_KEY_PATH');
  process.exit(1);
}

console.log(`Connecting to ${address} (namespace: ${namespace})...`);

const conn = await Connection.connect({
  address,
  tls: {
    clientCertPair: {
      crt: readFileSync(certPath),
      key: readFileSync(keyPath),
    },
  },
});

try {
  const info = await conn.workflowService.getSystemInfo({});
  console.log('✓ Connected. Server version:', info.serverVersion);
  console.log('✓ Bun + @temporalio/client compat confirmed.');
} finally {
  await conn.close();
}
