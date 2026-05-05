import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

/**
 * Tiny activity wrapper around the `autoDeploy` config flag. Workflows
 * can't read nexus.json directly (file I/O is non-deterministic from
 * the workflow's perspective); this activity centralizes the lookup
 * so PipelineWorkflow can branch on it.
 *
 * Returns true for repos like [target-repo-web] where Render auto-deploys
 * on merge — Forge has nothing to do at deploy time.
 */
export async function isAutoDeployRepo(params: {
  repoName?: string;
}): Promise<boolean> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);
  return repoConfig.autoDeploy === true;
}
