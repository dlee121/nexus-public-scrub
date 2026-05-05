/**
 * Unit tests for trigger.ts's pure helpers — currently just
 * `applyRepoFallback`. Avoids spinning up Temporal or hitting OpenAI
 * by testing the in-place mutation logic directly.
 */

import { describe, expect, test } from 'bun:test';
import { applyRepoFallback } from '../cli/trigger-helpers';
import type { WavePlan } from '../types';

const VALID_REPOS = new Set([
  '[target-repo-realtime]',
  '[target-repo-web]',
  '[target-repo-api]',
]);

function plan(tickets: Array<Partial<{ id: string; repoName: string }>>): WavePlan {
  return {
    instruction: 'test',
    waves: [
      {
        wave: 1,
        tickets: tickets.map((t, i) => ({
          id: t.id ?? `TKT-00${i + 1}`,
          title: 'a',
          description: 'b',
          acceptanceCriteria: ['c'],
          ...(t.repoName ? { repoName: t.repoName } : {}),
        })),
      },
    ],
  };
}

describe('applyRepoFallback', () => {
  test('preserves planner-emitted repoName when set', () => {
    const wp = plan([{ id: 'TKT-001', repoName: '[target-repo-web]' }]);
    applyRepoFallback(wp, '[target-repo-realtime]', VALID_REPOS);
    expect(wp.waves[0].tickets[0].repoName).toBe('[target-repo-web]');
  });

  test('falls back to --repo flag when planner omits repoName', () => {
    const wp = plan([{ id: 'TKT-001' }]); // no repoName
    applyRepoFallback(wp, '[target-repo-realtime]', VALID_REPOS);
    expect(wp.waves[0].tickets[0].repoName).toBe('[target-repo-realtime]');
  });

  test('mixes preservation and fallback in the same plan', () => {
    const wp = plan([
      { id: 'TKT-001', repoName: '[target-repo-web]' },
      { id: 'TKT-002' },
      { id: 'TKT-003', repoName: '[target-repo-api]' },
    ]);
    applyRepoFallback(wp, '[target-repo-realtime]', VALID_REPOS);
    const repos = wp.waves[0].tickets.map((t) => t.repoName);
    expect(repos).toEqual([
      '[target-repo-web]',
      '[target-repo-realtime]',
      '[target-repo-api]',
    ]);
  });

  test('throws when the resolved repoName is unknown', () => {
    const wp = plan([{ id: 'TKT-001', repoName: 'ruby-fictional' }]);
    expect(() =>
      applyRepoFallback(wp, '[target-repo-realtime]', VALID_REPOS),
    ).toThrow(/invalid repoName/);
  });

  test('throws when the fallback itself is unknown (--repo with bad name)', () => {
    const wp = plan([{ id: 'TKT-001' }]);
    expect(() =>
      applyRepoFallback(wp, 'ruby-not-registered', VALID_REPOS),
    ).toThrow(/invalid repoName/);
  });
});
