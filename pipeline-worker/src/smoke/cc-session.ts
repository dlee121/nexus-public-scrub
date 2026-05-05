import { spawnSync } from 'child_process';

export async function smokeCCSession(): Promise<void> {
  const result = spawnSync(
    'claude',
    ['-p', '--verbose', '--max-turns', '2', '--output-format', 'stream-json',
     '--append-system-prompt', 'You are a smoke test agent.'],
    { input: 'Reply with exactly the word: SMOKE_TEST_PASS', encoding: 'utf8', timeout: 30_000 }
  );

  if (result.status !== 0) {
    throw new Error(`claude exited ${result.status}: ${result.stderr}`);
  }

  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  const text = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((e: any) => e.type === 'assistant' || e.type === 'text' || e.type === 'result')
    .map((e: any) => {
      const raw = e.message?.content ?? e.content ?? e.result ?? '';
      if (Array.isArray(raw)) {
        return (raw as any[]).filter(b => b.type === 'text').map(b => b.text).join('');
      }
      return String(raw);
    })
    .join('');

  if (!text.includes('SMOKE_TEST_PASS')) {
    throw new Error(`Expected SMOKE_TEST_PASS in output, got: ${text.slice(0, 200)}`);
  }
}
