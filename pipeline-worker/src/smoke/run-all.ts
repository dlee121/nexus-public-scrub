/**
 * Layer 0 BFS smoke tests — runs all five external-service checks.
 * All five must pass before starting Chunk 1.
 * Run: bun run src/smoke/run-all.ts
 */

import { smokeTemporalConnectivity } from './temporal';
import { smokeCCSession } from './cc-session';
import { smokeOpenAI } from './openai';
import { smokeGitHubAPI } from './github';
import { smokeCodeArtifact } from './codeartifact';

const tests = [
  { name: 'Temporal connectivity', fn: smokeTemporalConnectivity },
  { name: 'Claude Code (claude -p) session', fn: smokeCCSession },
  { name: 'OpenAI evaluator endpoint', fn: smokeOpenAI },
  { name: 'GitHub Checks API', fn: smokeGitHubAPI },
  { name: 'CodeArtifact auth token', fn: smokeCodeArtifact },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    await test.fn();
    console.log(`  ✓  ${test.name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${test.name}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${passed}/${tests.length} smoke tests passed.`);
if (failed > 0) {
  console.error(`${failed} failed — resolve before starting Chunk 1.`);
  process.exit(1);
}
console.log('All clear. Ready for Chunk 1.');
