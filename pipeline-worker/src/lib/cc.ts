import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import { dropPrivilegesIfRoot } from './cc-priv';
import { resolveSessionJsonlPath } from './transcript';

export interface CCSessionResult {
  /** Full stdout buffer captured during the session. */
  stdout: string;
  /** session_id sniffed from the stream-json `init` system message; null if missing. */
  sessionId: string | null;
  /**
   * Absolute path to the JSONL Claude Code wrote for this session, or
   * null when sessionId wasn't captured. Computed at exit time, not
   * verified to exist on disk.
   */
  sessionJsonlPath: string | null;
}

const NEXUS_CORE = process.env.NEXUS_CORE_PATH ?? '/Users/<user>/Nexus/core';

export type CCPhase = 'implement' | 'verify' | 'patrol' | 'review' | 'address-review';

/** CLI effort levels accepted by `claude --effort <level>` (claude 2.1.119+). */
export type CCEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PhaseConfig {
  maxTurns: number;
  timeoutMs: number;
  /** Passed as `--model` to the claude CLI. Pins the model per phase. */
  model: string;
  /**
   * Optional: passed as `--effort <level>` to the claude CLI when set.
   * Maps to extended-thinking budget for Opus models. Omit for default
   * effort. Set on the three Opus phases that do code reasoning
   * (implement, address-review, review); Sonnet phases leave it unset.
   */
  effort?: CCEffort;
}

export interface CCSessionOptions {
  worktreePath: string;
  ticketId: string;
  /** Target repo for prompt-template selection. Defaults to realtime-platform. */
  repoName?: string;
  maxTurns: number;
  timeoutMs: number;
  initialMessage: string;
  sessionPhase: CCPhase;
}

// Per-phase CC session config. `model` and (optional) `effort` are passed
// as `--model` and `--effort` to the claude CLI. Without explicit `--model`
// every phase inherited the CLI's default (Opus 4.7) and burned Opus
// tokens on work that doesn't need Opus reasoning.
//
// Cost/quality split:
//   implement       Opus + effort=high — does the actual coding; reasoning
//                                         depth on architecture decisions
//                                         and edge cases is what makes the
//                                         downstream PR worth opening.
//   address-review  Opus + effort=high — applies fixes per review findings;
//                                         same code-judgment depth as
//                                         implement, in the same worktree.
//   review          Opus + effort=high — gates merge; mistakes here let
//                                         bad code through, so we pay for
//                                         max thinking.
//   verify          Sonnet — lint/test orchestration only; no code judgment.
//   patrol          Sonnet — issue triage; default effort is plenty.
//
// `effort: 'high'` is reserved for the three Opus phases that actually do
// code reasoning. Verify/patrol stay at the CLI default — they don't gain
// from extended-thinking budget on Sonnet.
export const CC_PHASE_CONFIG: Record<CCPhase, PhaseConfig> = {
  implement:        { maxTurns: 200, timeoutMs: 90 * 60 * 1000, model: 'claude-opus-4-7',   effort: 'high' },
  verify:           { maxTurns: 20,  timeoutMs: 15 * 60 * 1000, model: 'claude-sonnet-4-6' },
  patrol:           { maxTurns: 40,  timeoutMs: 20 * 60 * 1000, model: 'claude-sonnet-4-6' },
  // /review fans out to a Haiku eligibility check + 5 parallel Sonnet
  // reviewers + per-finding Haiku scorers internally. The session itself
  // only dispatches and gathers, BUT it gates the merge — false negatives
  // here ship bugs.
  review:           { maxTurns: 80,  timeoutMs: 25 * 60 * 1000, model: 'claude-opus-4-7',   effort: 'high' },
  'address-review': { maxTurns: 100, timeoutMs: 25 * 60 * 1000, model: 'claude-opus-4-7',   effort: 'high' },
};

export async function runCCSession(opts: CCSessionOptions): Promise<CCSessionResult> {
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
  // expiry guard + optional inline refresh).
  const drop = await dropPrivilegesIfRoot(opts.worktreePath);
  const ranAsUbuntu = drop.uid !== undefined;

  return new Promise<CCSessionResult>((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.worktreePath,
      env: {
        ...process.env,
        CLAUDE_PIPELINE_TICKET: opts.ticketId,
        CLAUDE_PIPELINE_PHASE: opts.sessionPhase,
        ...drop.envOverlay,
      },
      uid: drop.uid,
      gid: drop.gid,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CC session timed out after ${opts.timeoutMs}ms (phase: ${opts.sessionPhase})`));
    }, opts.timeoutMs);

    child.on('exit', () => clearTimeout(killTimer));

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let sessionId: string | null = null;

    child.stdout.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stdout += chunk;
      // Cheap session_id sniff parallel to cc-streamed.ts so the non-streamed
      // entry point produces the same transcript metadata.
      if (sessionId !== null) return;
      lineBuffer += chunk;
      let nl: number;
      while ((nl = lineBuffer.indexOf('\n')) >= 0 && sessionId === null) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { session_id?: unknown };
          if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
        } catch {
          // Partial / non-JSON during streaming — ignore.
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({
          stdout,
          sessionId,
          sessionJsonlPath: resolveSessionJsonlPath(sessionId, opts.worktreePath, ranAsUbuntu),
        });
      } else {
        reject(new Error(`CC session exited ${code}\nstderr: ${stderr}\nstdout: ${stdout.slice(0, 500)}`));
      }
    });
  });
}
