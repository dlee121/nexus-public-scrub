/**
 * Canonical, hardcoded deploy commands for repos where the exact make
 * target matters and must not drift via nexus.json edits.
 *
 * Why this exists: DK explicitly directed that the realtime-platform
 * deploy targets are `make eb-deploy-dev-tagged` and
 * `make eb-deploy-prod-tagged` exactly — no abbreviations, no
 * variations. Reading the command string directly from nexus.json
 * means a typo or accidental edit (e.g. shortening to `make eb-deploy`)
 * would silently produce a wrong deploy. This module makes the
 * canonical strings live in source where they're code-reviewed,
 * type-checked, and immune to config drift.
 *
 * For repos NOT in the hardcoded list (e.g. [target-repo-web]'s no-op echo,
 * [target-repo-api]'s `make deploy`), `resolveDeployCommand` falls
 * back to the configured value — preserves the per-repo flexibility
 * for repos where strict pinning isn't required.
 *
 * If nexus.json drifts from the canonical for a hardcoded repo, we
 * use the canonical anyway and log a loud warning so the operator
 * sees the drift in journald and can clean up the config.
 */

const HARDCODED_DEPLOY_COMMANDS: Record<string, { dev: string; prod: string }> = {
  // realtime-platform: tagged Elastic Beanstalk deploys, dev and prod
  // are distinct targets. Per DK's directive these MUST be exact —
  // they bake the tag step into the make recipe and a non-tagged
  // variation would push without the version label.
  //
  // SKIP_ECR_PUSH=1 prefix added 2026-05-02 ([target-repo-realtime]
  // PR #169): the eb-deploy-{dev,prod}-tagged recipes were restored to
  // all-in-one (build+push+deploy) for DK's local workflow, with
  // SKIP_ECR_PUSH=1 as the escape hatch for hosts without Docker. The
  // forge-worker on EC2 has no Docker daemon, so it must always pass
  // the flag — otherwise the build half hits `docker: command not
  // found` and the recipe fails with exit 127. The flag is benign on
  // any host that has Docker too; it just skips the local build+push
  // and trusts CI to have already pushed the image.
  '[target-repo-realtime]': {
    dev: 'SKIP_ECR_PUSH=1 make eb-deploy-dev-tagged',
    prod: 'SKIP_ECR_PUSH=1 make eb-deploy-prod-tagged',
  },
};

export type DeployEnv = 'dev' | 'prod';

/**
 * Return the deploy command to run for `repoName` × `env`. For repos
 * with hardcoded canonical commands, always returns the canonical
 * string (config drift is logged but ignored). For other repos,
 * returns the configured value as-is.
 */
export function resolveDeployCommand(
  repoName: string,
  env: DeployEnv,
  configured: string,
): string {
  const hardcoded = HARDCODED_DEPLOY_COMMANDS[repoName];
  if (!hardcoded) return configured;

  const canonical = env === 'dev' ? hardcoded.dev : hardcoded.prod;
  if (configured !== canonical) {
    process.stderr.write(
      `[deploy-commands] nexus.json ${env} command for ${repoName} drifted from canonical. ` +
        `configured="${configured}" canonical="${canonical}". Using canonical — please clean up nexus.json.\n`,
    );
  }
  return canonical;
}
