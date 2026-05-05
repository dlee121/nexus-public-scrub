import { spawnSync } from 'child_process';

export async function checkAncestryActivity(olderSha: string, newerSha: string): Promise<boolean> {
  const base = process.env.FORGE_DEPLOY_CHECKOUT_BASE ?? '/opt/nexus/repos';
  const deployPath = `${base}/[target-repo-realtime]-deploy`;

  const result = spawnSync('git', ['merge-base', '--is-ancestor', olderSha, newerSha], {
    cwd: deployPath,
  });
  return result.status === 0;
}
