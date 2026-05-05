/**
 * Unit tests for the plan validation surface — `assertTicket`,
 * `assertWavePlan`, and the `formatRepoCatalog` helper.
 *
 * These avoid hitting OpenAI by exercising the validation layer
 * directly with hand-crafted JSON. Run with `bun test src/tests/`.
 */

// Imports the pure validation surface — `cli/plan-validation.ts` —
// rather than `cli/plan.ts`, which loads `lib/openai.ts` and would
// instantiate the OpenAI client at module load (throws when
// OPENAI_API_KEY is unset). The validation module has no network
// dependency so no env stub is needed.

import { describe, expect, test } from 'bun:test';
import { assertTicket, assertWavePlan, formatRepoCatalog } from '../cli/plan-validation';

const VALID_REPOS = new Set([
  '[target-repo-realtime]',
  '[target-repo-web]',
  '[target-repo-api]',
]);

function validTicket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'TKT-001',
    repoName: '[target-repo-realtime]',
    title: 'Add presence tracking',
    description: 'Track active sessions and emit presence events.',
    acceptanceCriteria: ['Service emits presence on connect/disconnect'],
    ...overrides,
  };
}

describe('assertTicket', () => {
  test('accepts a well-formed ticket with valid repoName', () => {
    const t = assertTicket(validTicket(), 'tickets[0]', VALID_REPOS);
    expect(t.id).toBe('TKT-001');
    expect(t.repoName).toBe('[target-repo-realtime]');
    expect(t.acceptanceCriteria).toHaveLength(1);
  });

  test('rejects a ticket without repoName', () => {
    const bad = validTicket();
    delete bad.repoName;
    expect(() => assertTicket(bad, 'tickets[0]', VALID_REPOS)).toThrow(
      /repoName missing\/invalid/,
    );
  });

  test('rejects a ticket whose repoName is not in the registry', () => {
    const bad = validTicket({ repoName: 'ruby-typo-repo' });
    expect(() => assertTicket(bad, 'tickets[0]', VALID_REPOS)).toThrow(
      /not a registered Forge repo/,
    );
  });

  test('rejects empty repoName', () => {
    const bad = validTicket({ repoName: '' });
    expect(() => assertTicket(bad, 'tickets[0]', VALID_REPOS)).toThrow(
      /repoName missing\/invalid/,
    );
  });

  test('preserves rationale when present', () => {
    const t = assertTicket(
      validTicket({ rationale: 'because tests' }),
      'tickets[0]',
      VALID_REPOS,
    );
    expect(t.rationale).toBe('because tests');
  });

  test('rejects empty acceptanceCriteria', () => {
    const bad = validTicket({ acceptanceCriteria: [] });
    expect(() => assertTicket(bad, 'tickets[0]', VALID_REPOS)).toThrow(
      /acceptanceCriteria must be a non-empty array/,
    );
  });
});

describe('assertWavePlan', () => {
  test('accepts a single-repo single-wave plan', () => {
    const plan = {
      instruction: 'Fix the login flicker',
      waves: [{ wave: 1, tickets: [validTicket()] }],
    };
    const result = assertWavePlan(plan, VALID_REPOS);
    expect(result.waves).toHaveLength(1);
    expect(result.waves[0].tickets[0].repoName).toBe('[target-repo-realtime]');
  });

  test('accepts a cross-repo multi-wave plan', () => {
    const plan = {
      instruction: 'Add presence indicators',
      waves: [
        {
          wave: 1,
          tickets: [
            validTicket({ id: 'TKT-001', repoName: '[target-repo-realtime]' }),
          ],
        },
        {
          wave: 2,
          tickets: [
            validTicket({
              id: 'TKT-002',
              repoName: '[target-repo-api]',
              title: 'Expose /presence endpoint',
            }),
          ],
        },
        {
          wave: 3,
          tickets: [
            validTicket({
              id: 'TKT-003',
              repoName: '[target-repo-web]',
              title: 'Show presence dots',
            }),
          ],
        },
      ],
    };
    const result = assertWavePlan(plan, VALID_REPOS);
    const repoNames = result.waves.flatMap((w) => w.tickets.map((t) => t.repoName));
    expect(new Set(repoNames).size).toBe(3);
  });

  test('rejects when any ticket has a hallucinated repoName', () => {
    const plan = {
      instruction: 'Cross-repo work',
      waves: [
        { wave: 1, tickets: [validTicket()] },
        {
          wave: 2,
          tickets: [
            validTicket({ id: 'TKT-002', repoName: 'ruby-not-a-real-repo' }),
          ],
        },
      ],
    };
    expect(() => assertWavePlan(plan, VALID_REPOS)).toThrow(
      /not a registered Forge repo/,
    );
  });

  test('rejects empty waves array', () => {
    const plan = { instruction: 'noop', waves: [] };
    expect(() => assertWavePlan(plan, VALID_REPOS)).toThrow(
      /waves must be a non-empty array/,
    );
  });
});

describe('formatRepoCatalog', () => {
  test('emits a markdown-style block listing every registered repo', () => {
    const catalog = formatRepoCatalog();
    // Exact descriptions live in nexus.json; just confirm each repo name
    // appears in the output and the entry shape is `- <name>: <text>`.
    expect(catalog).toContain('[target-repo-realtime]');
    expect(catalog).toContain('[target-repo-web]');
    expect(catalog).toContain('[target-repo-api]');
    expect(catalog.split('\n').every((line) => line.startsWith('- '))).toBe(true);
  });
});
