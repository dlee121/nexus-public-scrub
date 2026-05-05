import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

export async function getSecret(secretName: string): Promise<Record<string, string>> {
  const resp = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
  const raw = resp.SecretString ?? '';
  return JSON.parse(raw);
}
