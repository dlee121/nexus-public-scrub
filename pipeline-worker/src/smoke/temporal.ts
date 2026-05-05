import { Connection } from '@temporalio/client';
import { readFileSync } from 'fs';

export async function smokeTemporalConnectivity(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS!;
  const certPath = process.env.TEMPORAL_TLS_CERT_PATH!;
  const keyPath = process.env.TEMPORAL_TLS_KEY_PATH!;

  const conn = await Connection.connect({
    address,
    tls: { clientCertPair: { crt: readFileSync(certPath), key: readFileSync(keyPath) } },
  });
  try {
    const info = await conn.workflowService.getSystemInfo({});
    if (!info.serverVersion) throw new Error('getSystemInfo returned no server version');
  } finally {
    await conn.close();
  }
}
