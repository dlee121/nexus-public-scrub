import { spawnSync } from 'child_process';

export async function getLatestOriginMainActivity(): Promise<string> {
  const base = process.env.FORGE_DEPLOY_CHECKOUT_BASE ?? '/opt/nexus/repos';
  const deployPath = `${base}/[target-repo-realtime]-deploy`;

  const fetchResult = spawnSync('git', ['fetch', 'origin', 'main'], {
    cwd: deployPath,
    encoding: 'utf-8',
  });
  if (fetchResult.status !== 0) {
    throw new Error(`git fetch origin main failed in ${deployPath}: ${fetchResult.stderr}`);
  }

  const revResult = spawnSync('git', ['rev-parse', 'origin/main'], {
    cwd: deployPath,
    encoding: 'utf-8',
  });
  if (revResult.status !== 0) {
    throw new Error(`git rev-parse origin/main failed in ${deployPath}: ${revResult.stderr}`);
  }

  return revResult.stdout.trim();
}
