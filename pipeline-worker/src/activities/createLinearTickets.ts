import { LinearClient } from '@linear/sdk';
import type { WavePlan, Ticket } from '../types';

/**
 * Creates Linear tickets for every ticket in every wave of the provided
 * WavePlan. The function awaits completion of all create-issue mutations
 * before returning, so the caller can assume the tickets exist once this
 * activity resolves.
 *
 * Required environment variables:
 *   - LINEAR_API_KEY  — Linear personal or OAuth API key
 *   - LINEAR_TEAM_ID  — team the issues should be created under
 */
export async function createLinearTickets(wavePlan: WavePlan): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error('LINEAR_API_KEY is not set');
  }

  const teamId = process.env.LINEAR_TEAM_ID;
  if (!teamId) {
    throw new Error('LINEAR_TEAM_ID is not set');
  }

  const client = new LinearClient({ apiKey });

  const flattened: Ticket[] = [];
  for (const wave of wavePlan.waves) {
    for (const ticket of wave.tickets) {
      flattened.push(ticket);
    }
  }

  console.log(
    `[createLinearTickets] Creating ${flattened.length} tickets across ${wavePlan.waves.length} wave(s)...`
  );

  await Promise.all(
    flattened.map(async (ticket) => {
      const description = buildDescription(ticket);
      const payload = await client.createIssue({
        teamId,
        title: ticket.title,
        description,
      });

      if (!payload.success) {
        throw new Error(
          `Linear createIssue did not report success for ticket "${ticket.id}" (${ticket.title})`
        );
      }

      const created = await payload.issue;
      console.log(
        `[createLinearTickets] Created Linear issue ${created?.identifier ?? '(unknown)'} for "${ticket.title}"`
      );
    })
  );

  console.log(
    `[createLinearTickets] Successfully created all ${flattened.length} tickets`
  );
}

function buildDescription(ticket: Ticket): string {
  const parts: string[] = [];

  if (ticket.description && ticket.description.trim().length > 0) {
    parts.push(ticket.description.trim());
  }

  if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
    const bullets = ticket.acceptanceCriteria
      .map((c) => `- ${c}`)
      .join('\n');
    parts.push(`## Acceptance Criteria\n${bullets}`);
  }

  if (ticket.rationale && ticket.rationale.trim().length > 0) {
    parts.push(`## Rationale\n${ticket.rationale.trim()}`);
  }

  return parts.join('\n\n');
}
