import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact';

export async function smokeCodeArtifact(): Promise<void> {
  const client = new CodeartifactClient({ region: process.env.AWS_REGION ?? 'us-west-2' });

  const resp = await client.send(new GetAuthorizationTokenCommand({
    domain: 'agentic',
    domainOwner: '[aws-account-id]',
    durationSeconds: 900,
  }));

  if (!resp.authorizationToken) throw new Error('CodeArtifact returned no token');
}
