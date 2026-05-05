import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact';
import { spawnSync, type SpawnSyncOptions } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config';

/**
 * True when `uv.lock` is checked into git at the worktree root. False if
 * the file is missing, untracked, or git itself fails (e.g. corrupt
 * worktree). `--error-unmatch` makes ls-files exit non-zero for untracked
 * paths; we discard stdout/stderr and read only the exit status.
 */
function isUvLockTracked(worktreePath: string): boolean {
  const result = spawnSync(
    'git',
    ['ls-files', '--error-unmatch', 'uv.lock'],
    { cwd: worktreePath, stdio: 'ignore' },
  );
  return result.status === 0;
}

export async function setupCodeArtifact(
  worktreePath: string,
  env: Record<string, string>
): Promise<void> {
  const { domain, domainOwner, region, repository } = config.pipeline.codeartifact;

  if (!repository) {
    throw new Error(
      'pipeline.codeartifact.repository is required in nexus.json. ' +
      'Expected value: "agentic-pypi"'
    );
  }

  const client = new CodeartifactClient({ region });
  const response = await client.send(new GetAuthorizationTokenCommand({
    domain,
    domainOwner,
    durationSeconds: 43200,
  }));
  const token = response.authorizationToken!;

  const indexUrl =
    `https://aws:${token}@${domain}-${domainOwner}.d.codeartifact.${region}.amazonaws.com` +
    `/pypi/${repository}/simple/`;

  env['UV_INDEX_URL'] = indexUrl;
  env['UV_EXTRA_INDEX_URL'] = 'https://pypi.org/simple/';

  const spawnOpts: SpawnSyncOptions = {
    cwd: worktreePath,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  };

  // Two install paths:
  //   - uv.lock tracked by git → `uv sync --frozen` (lock-pinned, fastest)
  //   - no tracked uv.lock     → `uv pip install -r requirements.txt` after `uv venv`
  // The second path covers repos like [target-repo-api] that use
  // requirements.txt only; `uv sync --frozen` would error out with
  // "Unable to find lockfile at uv.lock".
  //
  // We gate on `git ls-files --error-unmatch uv.lock` rather than plain
  // existsSync because IMPLEMENT runs Claude Code inside the worktree, and
  // CC's tool-belt occasionally emits a near-empty `uv.lock` (52 bytes,
  // header only) as a side-effect of `uv run`. Trusting that file would
  // hand `uv sync --frozen` an empty lock — which exits 0 and installs
  // nothing — leaving the venv bare and the subsequent `uv run black`
  // failing with "Failed to spawn: black". Tracking-state is the
  // canonical signal: the repo's intended manifest is whatever git owns,
  // not whatever happens to be on disk after IMPLEMENT.
  if (isUvLockTracked(worktreePath)) {
    const result = spawnSync(
      'uv',
      ['sync', '--frozen', '--index-strategy', 'unsafe-best-match'],
      spawnOpts,
    );
    if (result.status !== 0) {
      throw new Error(`uv sync failed in setupCodeArtifact (cwd: ${worktreePath})`);
    }
    return;
  }

  const requirementsPath = join(worktreePath, 'requirements.txt');
  if (!existsSync(requirementsPath)) {
    throw new Error(
      `Python repo at ${worktreePath} has neither uv.lock nor requirements.txt; ` +
      `cannot bootstrap dependencies via setupCodeArtifact.`,
    );
  }

  // `uv pip install` needs a target environment. It auto-detects `.venv`
  // in cwd, so we ensure it exists before installing. `uv venv` refuses
  // to overwrite by default, so guard with existsSync.
  if (!existsSync(join(worktreePath, '.venv'))) {
    const venvResult = spawnSync('uv', ['venv', '.venv'], spawnOpts);
    if (venvResult.status !== 0) {
      throw new Error(`uv venv failed in setupCodeArtifact (cwd: ${worktreePath})`);
    }
  }

  const installResult = spawnSync(
    'uv',
    ['pip', 'install', '--index-strategy', 'unsafe-best-match', '-r', 'requirements.txt'],
    spawnOpts,
  );
  if (installResult.status !== 0) {
    throw new Error(
      `uv pip install -r requirements.txt failed in setupCodeArtifact (cwd: ${worktreePath})`,
    );
  }

  if (existsSync(join(worktreePath, 'requirements-test.txt'))) {
    const testInstallResult = spawnSync(
      'uv',
      ['pip', 'install', '--index-strategy', 'unsafe-best-match', '-r', 'requirements-test.txt'],
      spawnOpts,
    );
    if (testInstallResult.status !== 0) {
      throw new Error(
        `uv pip install -r requirements-test.txt failed in setupCodeArtifact (cwd: ${worktreePath})`,
      );
    }
  }
}
