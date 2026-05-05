/**
 * Pure helpers for the forge-trigger CLI. Extracted from trigger.ts so
 * they can be unit-tested without spinning up Temporal or hitting OpenAI.
 */

import type { WavePlan } from '../types';

/**
 * Respect-then-fallback for ticket repoName.
 *
 * Walks every ticket in the wave plan:
 *   - If the ticket already has a non-empty repoName (from the planner),
 *     leave it. The planner is the source of truth.
 *   - Otherwise fall back to `fallbackRepoName` (the legacy `--repo`
 *     flag's resolved value).
 *
 * After assignment, every ticket is validated against `validRepoNames`.
 * An invalid name throws a clear error listing the valid choices —
 * cheaper than discovering the problem mid-pipeline when the worker
 * tries to clone an unknown repo.
 *
 * Mutates wavePlan.waves[*].tickets in place.
 */
export function applyRepoFallback(
  wavePlan: WavePlan,
  fallbackRepoName: string,
  validRepoNames: ReadonlySet<string>,
): void {
  for (const wave of wavePlan.waves) {
    for (const ticket of wave.tickets) {
      if (!ticket.repoName) {
        ticket.repoName = fallbackRepoName;
      }
      if (!validRepoNames.has(ticket.repoName)) {
        throw new Error(
          `Ticket ${ticket.id} has invalid repoName "${ticket.repoName}". ` +
          `Valid repos: ${Array.from(validRepoNames).join(', ')}`,
        );
      }
    }
  }
}
