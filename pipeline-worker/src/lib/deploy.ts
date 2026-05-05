import { spawnSync } from 'child_process';
import { existsSync } from 'fs';

const DEPLOY_CHECKOUT_BASE = process.env.FORGE_DEPLOY_CHECKOUT_BASE ?? '/opt/nexus/repos';

export function normalizeGitUrl(url: string): string {
  return url
    .replace(/^ssh:\/\/git@/, 'git@')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

export function prepareDeployCheckout(params: {
  repoOwner: string;
  repoName: string;
  targetSha: string;
}): string {
  const checkoutPath = `${DEPLOY_CHECKOUT_BASE}/${params.repoName}-deploy`;

  if (!existsSync(checkoutPath)) {
    throw new Error(
      `Deploy checkout not found at ${checkoutPath}. ` +
      'Run one-time provisioning: clone the repo there, copy .env files, run eb init.'
    );
  }

  // Fetch before reset — critical: check exit code before hard reset
  const fetchResult = spawnSync('git', ['fetch', 'origin'], {
    cwd: checkoutPath,
    stdio: 'inherit',
  });
  if (fetchResult.status !== 0) {
    throw new Error(`git fetch failed in deploy checkout (${checkoutPath}). Refusing to proceed with potentially stale code.`);
  }

  // Hard reset to exact target SHA
  const resetResult = spawnSync('git', ['reset', '--hard', params.targetSha], {
    cwd: checkoutPath,
    stdio: 'inherit',
  });
  if (resetResult.status !== 0) {
    throw new Error(`git reset --hard ${params.targetSha} failed in deploy checkout`);
  }

  return checkoutPath;
}
