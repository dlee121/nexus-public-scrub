import { spawnSync } from 'child_process';
import { prepareDeployCheckout } from '../lib/deploy';
import { resolveDeployCommand } from '../lib/deploy-commands';
import { resolveImageTagForRepo } from '../lib/ecr-tag-resolver';
import { getCommitFiles } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

/**
 * Conservative deny-list: paths that, when changed *exclusively*, do not
 * produce a deployable artifact. If a commit's full diff is contained in
 * this set, DEV_DEPLOY is a no-op (CI never built a Docker image, so
 * the ecr-tag-resolver would just spin until it timed out). Anything
 * outside this set defaults to "deploy" — false negatives waste a deploy
 * cycle, false positives skip a needed deploy, so we err toward deploying.
 */
function isNonDeployablePath(path: string): boolean {
  // GitHub-only metadata: workflows, dependabot, issue templates, etc.
  if (path.startsWith('.github/')) return true;
  // Documentation conventions.
  if (path.startsWith('docs/')) return true;
  if (path.endsWith('.md')) return true;
  if (path.endsWith('.rst')) return true;
  // Repo-root metadata files that don't ship in any artifact.
  const basename = path.split('/').pop() ?? path;
  if (
    basename === 'LICENSE' ||
    basename === 'NOTICE' ||
    basename === '.gitignore' ||
    basename === '.gitattributes' ||
    basename === '.editorconfig' ||
    basename === 'CODEOWNERS'
  ) return true;
  return false;
}

export async function devDeployActivity(params: {
  mergeSha: string;
  repoName?: string;
}): Promise<void> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);

  // Repos that auto-deploy on merge (e.g. Render, Vercel) don't need
  // anything from Forge at deploy time — the merge IS the deploy trigger.
  if (repoConfig.autoDeploy === true) {
    console.log(
      `[devDeploy] Skipping for ${repoConfig.repoName} (autoDeploy=true; ` +
      `${repoConfig.devEnvironment} handles deploys)`,
    );
    return;
  }

  // Skip when the merge touched only non-deployable paths (YAML/docs/etc).
  // CI doesn't build a Docker image for these merges, so ecr-tag-resolver
  // would spin until it timed out for nothing. Best-effort: any failure
  // listing files defaults to "deploy" so we don't accidentally swallow
  // a real deploy.
  try {
    const files = await getCommitFiles({
      owner: repoConfig.repoOwner,
      repo: repoConfig.repoName,
      sha: params.mergeSha,
    });
    if (files.length > 0 && files.every(isNonDeployablePath)) {
      console.log(
        `[devDeploy] Skipping for ${repoConfig.repoName} @ ${params.mergeSha.slice(0, 12)} ` +
        `— merge touched only non-deployable paths (${files.length} files: ` +
        `${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}). ` +
        `No Docker image built; nothing to deploy.`,
      );
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[devDeploy] getCommitFiles failed for ${params.mergeSha.slice(0, 12)} (${msg}); ` +
      `proceeding with deploy as if app code changed.`,
    );
  }

  const checkoutPath = prepareDeployCheckout({
    repoOwner: repoConfig.repoOwner,
    repoName: repoConfig.repoName,
    targetSha: params.mergeSha,
  });

  // Resolve via the canonical-commands helper so realtime-platform's
  // `make eb-deploy-dev-tagged` is locked to the source-of-truth string
  // even if nexus.json drifts. Other repos fall through to their config.
  const deployCmd = resolveDeployCommand(repoConfig.repoName, 'dev', repoConfig.deployDevCommand);

  // For repos that build images on CI and have Forge invoke a deploy-only
  // make recipe (currently just [target-repo-realtime] via the
  // SKIP_ECR_PUSH=1 prefix), Forge must supply the IMAGE_TAG since the
  // worktree is freshly cloned and has no .deployment-tag-dev. Query
  // ECR for the most-recently-pushed image matching the merge SHA;
  // throw if none found after retries (CI push hasn't completed).
  // Repos NOT in the registry get a null and their deploy command runs
  // unchanged.
  const imageTag = await resolveImageTagForRepo(repoConfig.repoName, 'dev', params.mergeSha);

  // Run via shell so we don't lose argument composition (commands like
  // `npm run deploy:dev` don't fit the old `['make', target]` shape).
  const result = spawnSync('bash', ['-lc', deployCmd], {
    cwd: checkoutPath,
    env: {
      ...process.env,
      PIPELINE: '1',
      ...(imageTag ? { IMAGE_TAG: imageTag } : {}),
    },
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(
      `Dev deploy failed (repo: ${repoConfig.repoName}, SHA: ${params.mergeSha}, ` +
      `cmd: ${deployCmd}${imageTag ? `, IMAGE_TAG: ${imageTag}` : ''})`,
    );
  }
}
