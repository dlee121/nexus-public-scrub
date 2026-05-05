import { Connection, Client } from '@temporalio/client';
import { readFileSync } from 'node:fs';

// Connection setup duplicated from pipeline-worker/src/temporal-client.ts to
// keep this package free of cross-package imports. The two implementations
// MUST stay structurally aligned — if you change cert handling here, mirror
// it in pipeline-worker. This is ~15 lines; not worth a shared package yet.

let _client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (_client) return _client;

  const address = requireEnv('TEMPORAL_ADDRESS');
  const certPath = requireEnv('TEMPORAL_TLS_CERT_PATH');
  const keyPath = requireEnv('TEMPORAL_TLS_KEY_PATH');
  const namespace = requireEnv('TEMPORAL_NAMESPACE');

  const connection = await Connection.connect({
    address,
    tls: {
      clientCertPair: {
        crt: readFileSync(certPath),
        key: readFileSync(keyPath),
      },
    },
  });

  _client = new Client({ connection, namespace });
  return _client;
}

export function getNamespace(): string {
  return requireEnv('TEMPORAL_NAMESPACE');
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing env var ${name}. Source forge-console/load-env.sh before running.`,
    );
  }
  return v;
}
