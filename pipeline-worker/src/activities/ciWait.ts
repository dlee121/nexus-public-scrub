import { waitForRequiredChecks } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

export async function ciWaitActivity(params: {
  prNumber: number;
  headSha: string;
  repoName?: string;
}): Promise<'success' | 'failure'> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);

  console.log(
    `[ciWait] Polling check runs for ${repoConfig.repoOwner}/${repoConfig.repoName}` +
    `@${params.headSha.slice(0, 12)} (PR #${params.prNumber})`
  );

  return waitForRequiredChecks({
    owner: repoConfig.repoOwner,
    repo: repoConfig.repoName,
    headSha: params.headSha,
  });
}
