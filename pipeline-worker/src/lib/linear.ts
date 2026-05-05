import { LinearClient } from '@linear/sdk';

let _client: LinearClient | null = null;

function getClient(): LinearClient {
  if (!_client) {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) throw new Error('LINEAR_API_KEY not set');
    _client = new LinearClient({ apiKey });
  }
  return _client;
}

export async function getTicket(ticketId: string): Promise<{
  id: string;
  title: string;
  description: string;
}> {
  const client = getClient();
  const issue = await client.issue(ticketId);
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description ?? '',
  };
}

export async function closeTicket(ticketId: string): Promise<void> {
  const client = getClient();
  const issue = await client.issue(ticketId);
  await issue.update({ stateId: 'done' }); // caller must supply correct state ID
}
