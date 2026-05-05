/**
 * `forge` CLI — operator-side commands for the Forge pipeline.
 *
 * Currently exposes:
 *   forge transcript <workflowId>
 *     [--output <file>]                    write to file instead of stdout
 *     [--include-orchestrator <jsonl>]     prepend an orchestrator session
 *                                          JSONL, merged in chronological
 *                                          order by `timestamp` field
 *
 * The transcript endpoint is served by forge-console at
 *   GET /api/workflows/<id>/transcript
 *
 * Auth (two layers, both required when going through forge.[company-domain]):
 *   - X-Forge-Token (app-layer authn at the Hono app). Sourced from
 *     FORGE_API_TOKEN env var. Same secret the worker uses; populated
 *     from /run/forge-worker.env on EC2 or your local dev shell.
 *   - CF-Access-Client-Id + CF-Access-Client-Secret (Cloudflare Access
 *     perimeter authn). Sourced from CF_ACCESS_CLIENT_ID and
 *     CF_ACCESS_CLIENT_SECRET. Required only when targeting the
 *     forge.[company-domain] public endpoint; CF Access blocks anonymous
 *     requests at the edge before X-Forge-Token can be inspected, so
 *     the CLI 403s without these. Local dev (http://127.0.0.1:4640) and
 *     on-EC2 use don't need them.
 *
 *     Generate a service token at:
 *       Cloudflare Zero Trust → Access → Service Auth → Create Service Token
 *     Bind it to the forge.[company-domain] application's policy.
 *
 * Console URL: FORGE_CONSOLE_URL env var (default http://127.0.0.1:4640
 * for local dev). On the operator's Mac through cloudflared, this is
 * the public forge.[company-domain] URL.
 */

import { readFile, writeFile } from 'fs/promises';

const DEFAULT_CONSOLE_URL = 'http://127.0.0.1:4640';

interface ForgeTranscriptArgs {
  workflowId: string;
  output: string | null;
  includeOrchestrator: string | null;
}

function parseTranscriptArgs(argv: string[]): ForgeTranscriptArgs | null {
  if (argv.length === 0) return null;
  let workflowId = '';
  let output: string | null = null;
  let includeOrchestrator: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output' || a === '-o') {
      output = argv[++i] ?? null;
    } else if (a === '--include-orchestrator') {
      includeOrchestrator = argv[++i] ?? null;
    } else if (!a.startsWith('-')) {
      if (!workflowId) workflowId = a;
    }
  }
  if (!workflowId) return null;
  return { workflowId, output, includeOrchestrator };
}

async function fetchWorkflowTranscript(workflowId: string): Promise<string> {
  const base = process.env.FORGE_CONSOLE_URL ?? DEFAULT_CONSOLE_URL;
  const token = process.env.FORGE_API_TOKEN ?? '';
  const cfClientId = process.env.CF_ACCESS_CLIENT_ID ?? '';
  const cfClientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
  const url = `${base.replace(/\/+$/, '')}/api/workflows/${encodeURIComponent(workflowId)}/transcript`;
  const headers: Record<string, string> = { Accept: 'application/x-ndjson' };
  if (token) headers['X-Forge-Token'] = token;
  // Both CF headers are required together; CF Access rejects requests
  // that present only one. Skip silently when targeting localhost so
  // local dev doesn't accidentally send service-token headers to the
  // app, where they'd be ignored anyway.
  if (cfClientId && cfClientSecret) {
    headers['CF-Access-Client-Id'] = cfClientId;
    headers['CF-Access-Client-Secret'] = cfClientSecret;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    // Cloudflare's edge returns 302 to the Access login page or HTML
    // 403s when the service token is missing/invalid. Surface that
    // hint so the operator knows whether to set CF_ACCESS_* or not.
    const isCfBlock =
      resp.status === 302 ||
      resp.status === 403 ||
      body.includes('Cloudflare') ||
      body.includes('cf-access');
    const cfHint =
      isCfBlock && !(cfClientId && cfClientSecret)
        ? ' (looks like a Cloudflare Access block; set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET)'
        : '';
    throw new Error(
      `transcript fetch failed: HTTP ${resp.status}${cfHint} ${body.slice(0, 300)}`,
    );
  }
  return await resp.text();
}

/**
 * Parse JSONL into objects + their original line text. Skips comment
 * lines (leading `#`) and blanks. Returns objects in source order.
 */
function parseJsonl(text: string): Array<{ obj: any; line: string }> {
  const out: Array<{ obj: any; line: string }> = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    try {
      const obj = JSON.parse(line);
      out.push({ obj, line });
    } catch {
      // Malformed line — preserve it as opaque so we don't lose data.
      out.push({ obj: null, line });
    }
  }
  return out;
}

/**
 * Stable chronological merge of two JSONL streams, keyed off the
 * `timestamp` field present on Claude Code's stream-json output. Lines
 * without a timestamp keep their source order relative to other
 * timestamp-less lines from the same source; a missing timestamp on
 * one side defers to the other. Output is exactly the original line
 * text (no re-serialization), preserving CC's native shape.
 */
function mergeJsonlByTimestamp(
  orchestratorText: string,
  workflowText: string,
): string {
  const o = parseJsonl(orchestratorText);
  const w = parseJsonl(workflowText);

  function ts(rec: { obj: any }): number {
    const t = rec.obj?.timestamp;
    if (typeof t === 'string') {
      const n = Date.parse(t);
      if (!Number.isNaN(n)) return n;
    }
    if (typeof t === 'number') return t;
    return Number.POSITIVE_INFINITY; // timestamp-less → drift to end of stream
  }

  const merged: string[] = [];
  let oi = 0;
  let wi = 0;
  while (oi < o.length && wi < w.length) {
    if (ts(o[oi]) <= ts(w[wi])) merged.push(o[oi++].line);
    else merged.push(w[wi++].line);
  }
  while (oi < o.length) merged.push(o[oi++].line);
  while (wi < w.length) merged.push(w[wi++].line);
  return merged.join('\n') + '\n';
}

/**
 * Strip the comment header lines forge-console emits (lines starting
 * with `#`). They're useful for diagnostics in the raw stream but the
 * exported file should be valid CC native JSONL.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
}

async function transcriptCommand(argv: string[]): Promise<number> {
  const args = parseTranscriptArgs(argv);
  if (!args) {
    process.stderr.write(
      'usage: forge transcript <workflowId> [--output <file>] [--include-orchestrator <jsonl>]\n',
    );
    return 2;
  }

  const workflowText = stripComments(await fetchWorkflowTranscript(args.workflowId));

  let final: string;
  if (args.includeOrchestrator) {
    const orchText = await readFile(args.includeOrchestrator, 'utf-8');
    final = mergeJsonlByTimestamp(orchText, workflowText);
  } else {
    final = workflowText.endsWith('\n') ? workflowText : workflowText + '\n';
  }

  if (args.output) {
    await writeFile(args.output, final, 'utf-8');
    process.stderr.write(`[forge] wrote ${final.length} bytes → ${args.output}\n`);
  } else {
    process.stdout.write(final);
  }
  return 0;
}

export async function forge(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === 'transcript') {
    const code = await transcriptCommand(argv.slice(1));
    if (code !== 0) process.exit(code);
    return;
  }
  process.stderr.write(
    [
      'usage: bun run src/index.ts forge <subcommand>',
      '',
      'subcommands:',
      '  transcript <workflowId> [--output <file>] [--include-orchestrator <jsonl>]',
      '',
    ].join('\n'),
  );
  process.exit(2);
}
