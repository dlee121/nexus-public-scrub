/**
 * Pure validation surface for the WavePlan structure the planner emits.
 *
 * Extracted from `cli/plan.ts` so that tests (and any future caller
 * that wants to validate a WavePlan without network access) don't have
 * to load `lib/openai.ts` and its module-level OpenAI client
 * constructor — that constructor throws if `OPENAI_API_KEY` isn't set,
 * which makes pure-validation tests painful to set up.
 */

import { getAllRepoConfigs } from '../config';
import type { WavePlan, Ticket } from '../types';

/**
 * Render the registered Forge repos as a catalog block for the planner's
 * system prompt. Each entry is `- <name>: <description>`. Missing
 * descriptions render as `(no description)` so the planner still has
 * the repo name to choose from.
 */
export function formatRepoCatalog(): string {
  const repos = getAllRepoConfigs();
  const entries = Object.values(repos).map((r) => {
    const desc = r.description ?? '(no description)';
    return `- ${r.repoName}: ${desc}`;
  });
  return entries.join('\n');
}

/**
 * Validate a single ticket from a WavePlan.
 *
 * `validRepoNames` is the set of acceptable repoName values. The planner
 * must emit a non-empty repoName from this set; missing or unknown
 * values throw with the full list of valid choices so the operator can
 * see what went wrong.
 */
export function assertTicket(
  value: unknown,
  path: string,
  validRepoNames: ReadonlySet<string>,
): Ticket {
  if (!value || typeof value !== 'object') {
    throw new Error(`${path} is not an object`);
  }
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || !t.id) throw new Error(`${path}.id missing/invalid`);
  if (typeof t.title !== 'string' || !t.title) throw new Error(`${path}.title missing/invalid`);
  if (typeof t.description !== 'string' || !t.description)
    throw new Error(`${path}.description missing/invalid`);
  if (typeof t.repoName !== 'string' || !t.repoName) {
    throw new Error(
      `${path}.repoName missing/invalid — planner must assign each ticket to one repo. Valid: ${Array.from(validRepoNames).join(', ')}`,
    );
  }
  if (!validRepoNames.has(t.repoName)) {
    throw new Error(
      `${path}.repoName "${t.repoName}" is not a registered Forge repo. Valid: ${Array.from(validRepoNames).join(', ')}`,
    );
  }
  if (!Array.isArray(t.acceptanceCriteria) || t.acceptanceCriteria.length === 0) {
    throw new Error(`${path}.acceptanceCriteria must be a non-empty array`);
  }
  for (let i = 0; i < t.acceptanceCriteria.length; i++) {
    if (typeof t.acceptanceCriteria[i] !== 'string') {
      throw new Error(`${path}.acceptanceCriteria[${i}] is not a string`);
    }
  }
  const ticket: Ticket = {
    id: t.id,
    title: t.title,
    description: t.description,
    repoName: t.repoName,
    acceptanceCriteria: t.acceptanceCriteria as string[],
  };
  if (typeof t.rationale === 'string') ticket.rationale = t.rationale;
  return ticket;
}

/**
 * Validate a WavePlan structure. `validRepoNames` is threaded through
 * to `assertTicket` for repo validation.
 */
export function assertWavePlan(value: unknown, validRepoNames: ReadonlySet<string>): WavePlan {
  if (!value || typeof value !== 'object') {
    throw new Error('Response is not a JSON object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.instruction !== 'string' || !obj.instruction) {
    throw new Error('WavePlan.instruction missing or not a string');
  }
  if (!Array.isArray(obj.waves) || obj.waves.length === 0) {
    throw new Error('WavePlan.waves must be a non-empty array');
  }
  const waves: Array<{ wave: number; tickets: Ticket[] }> = [];
  let totalTickets = 0;
  for (let i = 0; i < obj.waves.length; i++) {
    const w = obj.waves[i];
    if (!w || typeof w !== 'object') {
      throw new Error(`waves[${i}] is not an object`);
    }
    const wo = w as Record<string, unknown>;
    if (typeof wo.wave !== 'number' || !Number.isInteger(wo.wave) || wo.wave < 1) {
      throw new Error(`waves[${i}].wave must be a positive integer`);
    }
    if (!Array.isArray(wo.tickets) || wo.tickets.length === 0) {
      throw new Error(`waves[${i}].tickets must be a non-empty array`);
    }
    const tickets = wo.tickets.map((t, j) =>
      assertTicket(t, `waves[${i}].tickets[${j}]`, validRepoNames),
    );
    totalTickets += tickets.length;
    waves.push({ wave: wo.wave, tickets });
  }
  if (totalTickets === 0) {
    throw new Error('WavePlan has zero tickets');
  }
  return {
    instruction: obj.instruction,
    waves,
  };
}
