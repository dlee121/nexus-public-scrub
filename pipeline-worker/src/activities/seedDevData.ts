import { spawnSync } from 'child_process';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

export interface SeedResult {
  ran: boolean;
  exitCode: number;
  output: string;
}

/**
 * Hard guard: refuse to invoke the seed script if the target host
 * looks like production. Belt-and-braces — the seed script itself
 * should ALSO re-validate the target before any write, so a misnamed
 * env var doesn't accidentally drop fixtures into prod.
 *
 * Heuristic: hostname (or env-resolved config) must contain at least
 * one of these tokens (case-insensitive). If none match, refuse.
 */
const ALLOW_TOKENS = ['dev', 'develop', 'staging', 'stage', 'test', 'localhost', '127.0.0.1'];

/**
 * Tokens whose presence in the host string is treated as prod-coded.
 * Even if a "dev" token also matches, presence of any of these vetoes
 * the run — `clickhouse-prod-dev-replica.example.com` is still a write
 * we won't make.
 */
const DENY_TOKENS = ['prod', 'production'];

function classifyHost(host: string): { allowed: boolean; reason: string } {
  const h = host.trim().toLowerCase();
  if (!h) return { allowed: false, reason: 'empty host' };
  for (const tok of DENY_TOKENS) {
    if (h.includes(tok)) {
      return { allowed: false, reason: `host contains '${tok}' (deny-listed)` };
    }
  }
  for (const tok of ALLOW_TOKENS) {
    if (h.includes(tok)) {
      return { allowed: true, reason: `host contains '${tok}' (allow-listed)` };
    }
  }
  return {
    allowed: false,
    reason: `host '${h}' contains no allow-listed token (${ALLOW_TOKENS.join(', ')}); refusing as a safety default`,
  };
}

/**
 * Seed dev fixtures via the per-repo `seedFixturesScript`. Caller is
 * responsible for setting the relevant env vars (CLICKHOUSE_HOST,
 * CLICKHOUSE_USER, etc.) BEFORE invoking this activity — the activity
 * just inherits them and adds a hard prod-target refusal.
 *
 * Returns ran=false if no script is configured (no-op success). Returns
 * ran=true with non-zero exitCode on script failure (caller decides
 * whether to fail-fail or continue). Throws ONLY when the prod-target
 * guard fires — that's a misconfiguration the workflow should not
 * silently swallow.
 */
export async function seedDevDataActivity(params: {
  worktreePath: string;
  repoName?: string;
  /**
   * Env var name whose value should be classified by the prod guard.
   * Defaults to CLICKHOUSE_HOST (the canonical seed target). Override
   * when seeding into a different store (e.g. POSTGRES_HOST).
   */
  hostEnvVar?: string;
}): Promise<SeedResult> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);
  const script = repoConfig.seedFixturesScript;
  if (!script || !script.trim()) {
    const msg = `[seedDevData] no seedFixturesScript configured for ${repoConfig.repoName}; skipping`;
    console.log(msg);
    return { ran: false, exitCode: 0, output: msg };
  }

  const hostEnvVar = params.hostEnvVar ?? 'CLICKHOUSE_HOST';
  const host = process.env[hostEnvVar] ?? '';
  const classification = classifyHost(host);
  if (!classification.allowed) {
    // ApplicationFailure-equivalent via a thrown Error — the workflow
    // fails the activity. We refuse to run the script entirely; this
    // must surface loudly so the operator notices the misconfiguration.
    throw new Error(
      `[seedDevData] PROD-TARGET REFUSAL: ${hostEnvVar}='${host}' — ${classification.reason}. ` +
      `Set ${hostEnvVar} to a dev/staging host (e.g. 'clickhouse-dev.example.com') and retry.`,
    );
  }

  console.log(
    `[seedDevData] ${repoConfig.repoName}: ${hostEnvVar}='${host}' classified as dev (${classification.reason}); running ${script}`,
  );

  const result = spawnSync('bash', [script], {
    cwd: params.worktreePath,
    env: { ...process.env, PIPELINE: '1', SEED_TARGET_VERIFIED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });

  return {
    ran: true,
    exitCode: result.status ?? 1,
    output: (result.stdout ?? '') + (result.stderr ?? ''),
  };
}
