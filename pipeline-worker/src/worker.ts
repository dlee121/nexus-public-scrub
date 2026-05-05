import { Worker, NativeConnection } from '@temporalio/worker';
import { readFileSync } from 'fs';
import * as dotenv from 'dotenv';
import * as activities from './activities';

dotenv.config({ path: '../.pipeline-secrets.env' });

async function main() {
  const address = process.env.TEMPORAL_ADDRESS!;
  const certPath = process.env.TEMPORAL_TLS_CERT_PATH!;
  const keyPath = process.env.TEMPORAL_TLS_KEY_PATH!;
  const namespace = process.env.TEMPORAL_NAMESPACE!;

  const connection = await NativeConnection.connect({
    address,
    tls: {
      clientCertPair: {
        crt: readFileSync(certPath),
        key: readFileSync(keyPath),
      },
    },
  });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: 'forge-pipeline',
    workflowsPath: require.resolve('./workflows'),
    activities,
  });

  console.log('[worker] Forge pipeline worker started. Task queue: forge-pipeline');
  await worker.run();
}

main().catch(err => {
  console.error('[worker] Fatal error:', err);
  process.exit(1);
});
