import { mergePR } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

export async function mergeActivity(params: {
  prNumber: number;
  repoName?: string;
}): Promise<string> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);
  console.log(`[merge] Merging PR #${params.prNumber} in ${repoConfig.repoName}`);
  return mergePR({
    owner: repoConfig.repoOwner,
    repo: repoConfig.repoName,
    prNumber: params.prNumber,
  });
}
