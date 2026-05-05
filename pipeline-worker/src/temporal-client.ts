import { Connection, Client } from '@temporalio/client';
import { readFileSync } from 'fs';

let _client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (_client) return _client;

  const address = process.env.TEMPORAL_ADDRESS!;
  const certPath = process.env.TEMPORAL_TLS_CERT_PATH!;
  const keyPath = process.env.TEMPORAL_TLS_KEY_PATH!;
  const namespace = process.env.TEMPORAL_NAMESPACE!;

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
