/**
 * cc-priv.ts — privilege-drop helper for CC subprocesses.
 *
 * The forge-worker runs as root so it can read /run/forge-worker.env
 * (root:0600) and write into /opt/nexus/repos. But the Claude Code CLI
 * refuses --dangerously-skip-permissions / --permission-mode bypassPermissions
 * under root, which means every CC tool call hits a permission prompt and
 * the session burns its turn budget on blocked operations.
 *
 * Fix: spawn CC as the unprivileged `ubuntu` user. Three prerequisites
 * the helper handles before the spawn:
 *   1. Chown the worktree so ubuntu can write to it.
 *   2. Mirror /root/.claude/.credentials.json into /home/ubuntu/.claude
 *      so the dropped-privilege CC has valid auth. (The Mac creds-sync
 *      writes only to /root/.claude; ubuntu's credentials file would
 *      otherwise be stale and the API would return 401.)
 *   3. Pre-spawn credential expiry guard (Gap 5):
 *        - If the access token is already expired, throw — don't even
 *          start CC; the activity retries in ~15s and by then a launchd
 *          sync may have pushed fresh creds.
 *        - If <60min of life remains, attempt an inline OAuth refresh
 *          against the same endpoint sync-claude-creds.sh uses
 *          (https://platform.claude.com/v1/oauth/token, public client_id
 *          9d1c250a-e61b-44d9-88ed-5944d1962f5e). Write the refreshed
 *          blob back to /root/.claude/.credentials.json so the next
 *          activity starts with the new value.
 *        - On refresh failure (network / 4xx / malformed response),
 *          fall through and copy the existing creds — a hard failure
 *          here is worse than a possible mid-session 401, since the
 *          token may still have enough life for the session.
 *
 * Returns the spawn options to merge into the child_process.spawn call.
 * If we're not root (dev / test), returns empty — no drop happens.
 */

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const UBUNTU_UID = 1000;
const UBUNTU_GID = 1000;
const UBUNTU_HOME = '/home/ubuntu';
const ROOT_CREDS = '/root/.claude/.credentials.json';

// OAuth refresh-token grant configuration. MUST stay in sync with
// scripts/sync-claude-creds.sh — the script and this module both refresh
// against the same endpoint with the same client_id and the same body
// shape. Drift would mean Mac and EC2 ask different servers for tokens.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh window: when remainingMs falls below this, attempt an inline
// refresh. 60 minutes covers the worst-case CC activity (35-min Temporal
// startToCloseTimeout) plus headroom for retries and slow turns.
const REFRESH_WINDOW_MS = 60 * 60 * 1000;

// HTTP timeout for the refresh call. Generous — we don't want the
// pre-spawn check to itself block a session for long, but a slow
// platform.claude.com response shouldn't kill us before it returns.
const REFRESH_TIMEOUT_MS = 10_000;

export interface DropPrivOpts {
  uid?: number;
  gid?: number;
  envOverlay: Record<string, string>;
}

/**
 * Recursively find the first numeric `expiresAt` value anywhere in the
 * parsed credentials blob. Mirrors the recursive search in
 * sync-claude-creds.sh's `parse_expires_ms` (jq's `.. | objects |
 * .expiresAt?`) so the two stay shape-agnostic against future Anthropic
 * payload changes.
 */
function findExpiresAtMs(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findExpiresAtMs(v);
      if (r !== null) return r;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.expiresAt === 'number') return o.expiresAt;
  for (const v of Object.values(o)) {
    const r = findExpiresAtMs(v);
    if (r !== null) return r;
  }
  return null;
}

/**
 * Attempt an OAuth refresh-token grant against the Anthropic token
 * endpoint. On success, returns the updated raw JSON blob ready to be
 * written back to disk; on any failure (missing refreshToken, network
 * error, non-2xx, malformed response, missing access_token), returns
 * null.
 *
 * Mirrors `attempt_oauth_refresh` in sync-claude-creds.sh — same
 * endpoint, same body shape, same response-handling rules. If you
 * change one, change the other.
 */
async function attemptInlineRefresh(rawBlob: string): Promise<string | null> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBlob);
  } catch {
    return null;
  }

  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
  const refreshToken = oauth && typeof oauth.refreshToken === 'string' ? oauth.refreshToken : '';
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString();

  let resp: Response;
  try {
    resp = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!resp.ok) return null;

  let data: Record<string, unknown>;
  try {
    data = (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const newAccess = typeof data.access_token === 'string' ? data.access_token : '';
  if (!newAccess) return null;

  const newRefresh = typeof data.refresh_token === 'string' && data.refresh_token
    ? data.refresh_token
    : refreshToken;

  const newOauth: Record<string, unknown> = {
    ...(oauth ?? {}),
    accessToken: newAccess,
    refreshToken: newRefresh,
  };

  if (typeof data.expires_at === 'number') {
    newOauth.expiresAt = data.expires_at;
  } else if (typeof data.expires_in === 'number') {
    newOauth.expiresAt = Date.now() + data.expires_in * 1000;
  }
  // If neither expiry field is present, keep the prior expiresAt.
  // Better than dropping it — downstream logic still has the field
  // even if it's now lying. The next refresh window check catches it.

  if (typeof data.scope === 'string' && data.scope.length > 0) {
    newOauth.scopes = data.scope.split(' ');
  }

  return JSON.stringify({ ...parsed, claudeAiOauth: newOauth });
}

export async function dropPrivilegesIfRoot(worktreePath: string): Promise<DropPrivOpts> {
  if (process.geteuid?.() !== 0) {
    return { envOverlay: {} };
  }

  spawnSync('chown', ['-R', `${UBUNTU_UID}:${UBUNTU_GID}`, worktreePath]);

  // Read root creds + expiry-guard before propagating to ubuntu.
  // We tolerate a missing/unparseable file by falling through to the
  // existing copy logic; the worker has run for months without this
  // pre-check and the operator's first signal is a mid-session 401.
  // The guard is a strict improvement, not a new mandatory dependency.
  let credBlob: string;
  try {
    credBlob = readFileSync(ROOT_CREDS, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cc-priv] could not read ${ROOT_CREDS}: ${msg}\n`);
    return privDropOpts();
  }

  const expiresAtMs = (() => {
    try {
      return findExpiresAtMs(JSON.parse(credBlob));
    } catch {
      return null;
    }
  })();

  if (expiresAtMs !== null) {
    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      // Hard fail — but plain Error so Temporal's retry policy gives
      // us another chance in ~15s. By then a launchd sync (4h cadence)
      // or a parallel inline refresh from another activity may have
      // pushed fresh creds.
      throw new Error(
        '[cc-priv] credentials expired — aborting spawn. launchd sync should push fresh creds within 4h.',
      );
    }
    if (remainingMs < REFRESH_WINDOW_MS) {
      const remainingMin = Math.floor(remainingMs / 60_000);
      const refreshed = await attemptInlineRefresh(credBlob);
      if (refreshed) {
        try {
          writeFileSync(ROOT_CREDS, refreshed, { mode: 0o600 });
          credBlob = refreshed;
          process.stderr.write(
            `[cc-priv] token refreshed inline (${remainingMin}min remaining)\n`,
          );
        } catch (err) {
          // Couldn't write the refreshed creds back. Use the in-memory
          // refreshed blob for the ubuntu copy below — this CC session
          // gets fresh auth, even if the next activity won't until the
          // next launchd sync writes /root/.claude/.credentials.json.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[cc-priv] inline refresh succeeded but write-back failed: ${msg}\n`,
          );
          credBlob = refreshed;
        }
      } else {
        process.stderr.write(
          `[cc-priv] inline refresh failed (${remainingMin}min remaining) — continuing with current token\n`,
        );
      }
    }
  }
  // expiresAtMs === null: parse failure or shape change. Don't refuse
  // the spawn — the session may still work, and refusing here would
  // block every spawn until the file is hand-fixed.

  // Copy the (possibly-refreshed) blob into ubuntu's home so the
  // dropped-privilege CC subprocess sees the fresh creds.
  try {
    const ubuntuClaudeDir = join(UBUNTU_HOME, '.claude');
    mkdirSync(ubuntuClaudeDir, { recursive: true });
    spawnSync('chown', [`${UBUNTU_UID}:${UBUNTU_GID}`, ubuntuClaudeDir]);
    const dest = join(ubuntuClaudeDir, '.credentials.json');
    writeFileSync(dest, credBlob, { mode: 0o600 });
    spawnSync('chown', [`${UBUNTU_UID}:${UBUNTU_GID}`, dest]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cc-priv] credential sync to ubuntu failed: ${msg}\n`);
  }

  return privDropOpts();
}

function privDropOpts(): DropPrivOpts {
  return {
    uid: UBUNTU_UID,
    gid: UBUNTU_GID,
    envOverlay: {
      HOME: UBUNTU_HOME,
      USER: 'ubuntu',
      LOGNAME: 'ubuntu',
    },
  };
}
