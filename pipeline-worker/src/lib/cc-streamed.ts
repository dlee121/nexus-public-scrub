/**
 * cc-streamed.ts — variant of `cc.ts`'s `runCCSession` with an optional
 * line-level stream tap.
 *
 * Why a separate file rather than modifying cc.ts: v2's brief explicitly
 * directed "do NOT touch cc.ts". This module re-implements the spawn loop
 * with a streaming hook so cc.ts can stay byte-for-byte stable. When v3
 * (interactive sessions for prompt injection) lands, both files should be
 * consolidated into a single canonical entry point — for now, the cost is
 * one duplicated spawn function.
 *
 * Behavioral parity with `cc.ts`:
 *   - Same args (-p, --verbose, --max-turns, --output-format stream-json,
 *     --append-system-prompt)
 *   - Same env (NEXUS_CORE inherits, plus CLAUDE_PIPELINE_TICKET / _PHASE)
 *   - Same timeout-via-SIGTERM behavior
 *   - Same return value: full stdout buffer as a string
 *
 * What's added:
 *   - `onLine(rawJson: string)` callback fired once per stream-json line.
 *     Failure-isolated: if the callback throws, we log and continue. The
 *     activity's correctness depends on the spawn, NOT on the callback.
 */

import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import { CC_PHASE_CONFIG, type CCPhase } from './cc';
import { dropPrivilegesIfRoot } from './cc-priv';
import { resolveSessionJsonlPath } from './transcript';

export interface CCSessionStreamedResult {
  /** Full stdout buffer captured during the session. */
  stdout: string;
  /** session_id sniffed from the stream-json `init` system message; null if missing. */
  sessionId: string | null;
  /**
   * Absolute path to the JSONL Claude Code wrote for this session, or
   * null when sessionId wasn't captured. Computed at exit time, not
   * verified to exist on disk — the caller can stat() / read() to
   * confirm before promising the file to a downstream reader.
   */
  sessionJsonlPath: string | null;
}

const NEXUS_CORE = process.env.NEXUS_CORE_PATH ?? '/Users/<user>/Nexus/core';

export interface CCSessionStreamedOptions {
  worktreePath: string;
  ticketId: string;
  /** Target repo for prompt-template selection. Defaults to realtime-platform. */
  repoName?: string;
  maxTurns: number;
  timeoutMs: number;
  initialMessage: string;
  sessionPhase: CCPhase;
  /**
   * Called once per stream-json line as it arrives on stdout. Synchronous;
   * if you need to do async work (e.g. fire an HTTP POST), kick it off
   * and return immediately — don't await. Throws are caught and logged.
   */
  onLine?: (rawJsonLine: string) => void;
}

export async function runCCSessionStreamed(
  opts: CCSessionStreamedOptions,
): Promise<CCSessionStreamedResult> {
  const repoConfig = getRepoConfig(opts.repoName ?? DEFAULT_REPO_NAME);
  const claudeMdPath = join(NEXUS_CORE, repoConfig.claudeMdPath);
  const agentsMdPath = join(NEXUS_CORE, repoConfig.agentsMdPath);

  let systemPrompt = readFileSync(claudeMdPath, 'utf-8');
  try {
    systemPrompt += '\n\n' + readFileSync(agentsMdPath, 'utf-8');
  } catch {
    // AGENTS.md starts empty — that's fine
  }

  const phaseConfig = CC_PHASE_CONFIG[opts.sessionPhase];
  const args = [
    '-p', opts.initialMessage,
    '--verbose',
    '--max-turns', String(opts.maxTurns),
    '--output-format', 'stream-json',
    '--append-system-prompt', systemPrompt,
    // Pin the model per-phase so we don't burn Opus tokens on phases that
    // don't need Opus reasoning. Sourced from CC_PHASE_CONFIG so phase and
    // model stay paired — callers can't accidentally drift them.
    '--model', phaseConfig.model,
    // Forge runs unattended in an isolated EC2 worktree. Without this flag CC
    // hits permission prompts on every Bash multi-op / Write / mkdir and
    // burns its turn budget retrying blocked operations.
    '--dangerously-skip-permissions',
  ];
  // Optional `--effort` (extended-thinking budget). Only added when the
  // phase config sets it; absent flag keeps the CLI default.
  if (phaseConfig.effort) {
    args.push('--effort', phaseConfig.effort);
  }

  // dropPrivilegesIfRoot is now async (Gap 5: pre-spawn credential
  // expiry guard + optional inline refresh). It can throw if creds
  // are already expired; let that bubble so the activity retries.
  const drop = await dropPrivilegesIfRoot(opts.worktreePath);
  const ranAsUbuntu = drop.uid !== undefined; // priv-drop fired iff uid was set

  return new Promise<CCSessionStreamedResult>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.worktreePath,
      env: {
        ...process.env,
        CLAUDE_PIPELINE_TICKET: opts.ticketId,
        CLAUDE_PIPELINE_PHASE: opts.sessionPhase,
        // Mirror GITHUB_TOKEN → GH_TOKEN so the `gh` CLI invoked by the
        // /review skill (and any future gh-based skills) authenticates
        // without a separate `gh auth login`. The skill's frontmatter
        // hard-restricts allowed-tools to specific `gh` subcommands, so
        // we cannot replace it with octokit calls inside the session.
        GH_TOKEN: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '',
        ...drop.envOverlay,
      },
      uid: drop.uid,
      gid: drop.gid,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `CC session timed out after ${opts.timeoutMs}ms (phase: ${opts.sessionPhase})`,
        ),
      );
    }, opts.timeoutMs);

    child.on('exit', () => clearTimeout(killTimer));

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    // session_id is sniffed from the stream-json `init` system message so the
    // failure log is correlatable with what's in the journal/CC's own logs.
    // `null` means we either haven't seen the init message yet or the child
    // died before printing it; the log filename falls back to a timestamp.
    let sessionId: string | null = null;

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;

      lineBuffer += chunk;
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;

        // Cheap session_id sniff. Stops parsing once captured. Failures
        // are silent — partial JSON or non-JSON lines are normal during
        // streaming.
        if (sessionId === null) {
          try {
            const parsed = JSON.parse(line) as { session_id?: unknown };
            if (typeof parsed.session_id === 'string') {
              sessionId = parsed.session_id;
            }
          } catch {
            // not JSON yet — ignore
          }
        }

        if (opts.onLine) {
          try {
            opts.onLine(line);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[cc-streamed] onLine threw, continuing: ${msg}\n`);
          }
        }
      }
    });

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('exit', (code) => {
      // Flush any tail content not terminated by a newline.
      if (opts.onLine && lineBuffer.trim()) {
        try {
          opts.onLine(lineBuffer.trim());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[cc-streamed] final onLine threw: ${msg}\n`);
        }
        lineBuffer = '';
      }

      if (code === 0) {
        resolve({
          stdout,
          sessionId,
          sessionJsonlPath: resolveSessionJsonlPath(sessionId, opts.worktreePath, ranAsUbuntu),
        });
        return;
      }

      // Failure path: persist FULL stdout + stderr to a log file so the
      // failure can be diagnosed after the activity returns. journald
      // truncates large messages and the previous 500-char inline slice
      // often cut off right inside the ANSI escape that opens the model
      // banner — which made every IMPLEMENT failure look identical.
      // Filename: <ticketId>-<sessionId>.log so multiple ticket runs
      // don't collide and the operator can grep by either coordinate.
      const logDir = '/tmp/forge-worktrees';
      const fileTag = sessionId ?? `no-session-${Date.now()}`;
      const logPath = `${logDir}/${opts.ticketId}-${fileTag}.log`;
      try {
        mkdirSync(logDir, { recursive: true });
        writeFileSync(
          logPath,
          [
            `=== CC session failure ===`,
            `exitCode:    ${code}`,
            `ticketId:    ${opts.ticketId}`,
            `sessionId:   ${sessionId ?? '(not captured)'}`,
            `phase:       ${opts.sessionPhase}`,
            `timestamp:   ${new Date().toISOString()}`,
            `worktree:    ${opts.worktreePath}`,
            ``,
            `=== stderr ===`,
            stderr,
            `=== stdout ===`,
            stdout,
          ].join('\n'),
        );
      } catch (writeErr) {
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        process.stderr.write(`[cc-streamed] failed to write CC log to ${logPath}: ${msg}\n`);
      }

      reject(
        new Error(
          `CC session exited ${code} (full log: ${logPath})\nstderr: ${stderr}`,
        ),
      );
    });
  });
}
