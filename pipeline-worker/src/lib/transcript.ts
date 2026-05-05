/**
 * Transcript helpers — resolve the on-disk path of the JSONL file Claude
 * Code wrote for a given session.
 *
 * Claude Code stores per-session transcripts at:
 *   <home>/.claude/projects/<encoded-cwd>/<session_id>.jsonl
 *
 * `<encoded-cwd>` is the absolute working directory with `/` replaced by
 * `-` (leading dash preserved). E.g. `/tmp/forge-worktrees/TKT-001`
 * becomes `-tmp-forge-worktrees-TKT-001`.
 *
 * On the EC2 worker the spawned `claude` runs as `ubuntu` (see cc-priv.ts
 * — the worker is root, but CC refuses --dangerously-skip-permissions
 * under root, so the spawn drops privs). That means the JSONL lands in
 * `/home/ubuntu/.claude/projects/...`, not `/root/.claude/...`.
 *
 * For local dev (Mac, where the worker isn't root), CC runs as the
 * operator and writes to their `$HOME/.claude/...`.
 */

import { join } from 'path';

const UBUNTU_HOME = '/home/ubuntu';

/**
 * Encode a working-directory path the way Claude Code does for its
 * project bucket name. `replaceAll('/', '-')`, leading dash kept.
 */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

/**
 * Build the absolute JSONL path Claude Code wrote for `sessionId` when
 * it ran in `worktreePath`. `ranAsUbuntu` mirrors the priv-drop decision
 * `cc-priv.dropPrivilegesIfRoot` made — true on the EC2 worker, false
 * for local dev / tests where the worker isn't root.
 *
 * Returns null when sessionId is missing (the CC subprocess died before
 * emitting its `init` message, or the stream-json sniff failed).
 */
export function resolveSessionJsonlPath(
  sessionId: string | null,
  worktreePath: string,
  ranAsUbuntu: boolean,
): string | null {
  if (!sessionId) return null;
  const home = ranAsUbuntu ? UBUNTU_HOME : (process.env.HOME ?? '/root');
  return join(home, '.claude', 'projects', encodeProjectPath(worktreePath), `${sessionId}.jsonl`);
}
