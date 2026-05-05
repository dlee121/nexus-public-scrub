/**
 * Resolve the ECR image tag CI most-recently pushed for a given merge SHA.
 *
 * Why this exists: [target-repo-realtime]'s deploy targets
 * (eb-deploy-{dev,prod}-tagged) accept either a `.deployment-tag-{env}`
 * file or an `IMAGE_TAG=<tag>` env override. Forge's freshly-cloned
 * worktree has neither — and the build half is skipped via
 * `SKIP_ECR_PUSH=1` because EC2 has no Docker daemon. So Forge must
 * supply the tag explicitly.
 *
 * The Makefile's tag scheme (per `generate-{dev,prod}-tag` recipes):
 *   dev-<short-sha>-<YYYYMMDD-HHMMSS>
 *   prod-<short-sha>-<YYYYMMDD-HHMMSS>
 *
 * `<short-sha>` is `git rev-parse --short HEAD` — typically 7 hex chars.
 * We query ECR for the most-recently-pushed image tag in the repo's
 * gateway image (any of the per-service repos would work; gateway is
 * arbitrary but stable) that starts with `<env>-<short-sha>` and
 * return its tag string.
 *
 * Failure mode: if CI hasn't finished pushing yet, no tag will be
 * found. We retry a few times (4 × 15s) before giving up. Beyond that,
 * the activity throws with a clear error and Temporal's activity
 * retry policy can take another swing — by which time CI's push
 * should have finished.
 */

import { spawnSync } from "child_process";

interface EcrTagConfig {
  region: string;
  /** Any per-service ECR repository under this app. Tags are written to
   *  every per-service repo in lockstep, so we only need to query one. */
  ecrRepository: string;
  /** Per-env tag prefix (the literal first segment of the tag scheme,
   *  before the SHA). */
  tagPrefix: { dev: string; prod: string };
}

const ECR_TAG_REGISTRY: Record<string, EcrTagConfig> = {
  // [target-repo-realtime]: ECR_REPO_PREFIX is `[target-repo-prefix]` (per the
  // repo's Makefile line ~268). Per-service images are pushed under
  // [target-repo-prefix]-{gateway,trigger-engine,template-service,...}. Gateway is
  // chosen as the canonical query target — all per-service images are
  // pushed together so any one would work. Tag scheme:
  //   dev-<short-sha>-<YYYYMMDD-HHMMSS>
  //   prod-<short-sha>-<YYYYMMDD-HHMMSS>
  "[target-repo-realtime]": {
    region: "us-west-2",
    ecrRepository: "[target-repo-realtime]-gateway",
    tagPrefix: { dev: "dev", prod: "prod" },
  },
};

export function getEcrTagConfig(repoName: string): EcrTagConfig | null {
  return ECR_TAG_REGISTRY[repoName] ?? null;
}

interface DescribeImagesOutput {
  pushedAt: string;
  tags: string[];
}

/**
 * Single ECR query. Returns the most-recently-pushed tag matching the
 * prefix, or null if none. Errors during the query are logged + null
 * is returned so the retry loop can decide what to do.
 */
function queryEcr(
  cfg: EcrTagConfig,
  expectedTagPrefix: string,
): string | null {
  // We pull all imageDetails and filter client-side. ECR doesn't support
  // server-side prefix filtering on tags, but the per-repo image count
  // is small enough (hundreds, not millions) that this is cheap.
  const result = spawnSync(
    "aws",
    [
      "ecr",
      "describe-images",
      "--region",
      cfg.region,
      "--repository-name",
      cfg.ecrRepository,
      "--query",
      "imageDetails[?imageTags!=`null`].{pushedAt:imagePushedAt,tags:imageTags}",
      "--output",
      "json",
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );

  if (result.status !== 0) {
    console.error(
      `[ecr-tag-resolver] aws ecr describe-images failed (exit ${result.status}): ${result.stderr?.slice(0, 400)}`,
    );
    return null;
  }

  let images: DescribeImagesOutput[];
  try {
    images = JSON.parse(result.stdout) as DescribeImagesOutput[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ecr-tag-resolver] failed to parse aws ecr output: ${msg}`);
    return null;
  }

  const matches: { tag: string; pushedAt: string }[] = [];
  for (const img of images) {
    for (const tag of img.tags ?? []) {
      if (tag.startsWith(expectedTagPrefix)) {
        matches.push({ tag, pushedAt: img.pushedAt });
      }
    }
  }
  if (matches.length === 0) return null;

  // Sort newest first by pushedAt (ISO-8601 string comparison is correct here)
  matches.sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));
  return matches[0].tag;
}

/**
 * Resolve the ECR image tag for a given repo + env + merge SHA. Returns
 * null if the repo isn't in the registry (caller should treat as "no
 * resolution needed; pass deploy command through unchanged"). Throws if
 * the repo IS in the registry but no tag could be found after retries
 * — a clear "CI didn't push, or push failed" signal.
 */
export async function resolveImageTagForRepo(
  repoName: string,
  env: "dev" | "prod",
  mergeSha: string,
): Promise<string | null> {
  const cfg = ECR_TAG_REGISTRY[repoName];
  if (!cfg) return null;

  const shortSha = mergeSha.slice(0, 7);
  const expectedPrefix = `${cfg.tagPrefix[env]}-${shortSha}`;

  // Budget tuned to outwait main-branch docker-build, which is the
  // slowest path that produces our tag. Empirically observed (May 2026)
  // at ~3–6 min for [target-repo-realtime]; previous 4×15s = 60s
  // budget made DEV_DEPLOY race the build and lose. 20×30s = 10 min
  // gives generous headroom; activity-level startToCloseTimeout (35 min)
  // and Temporal retry (3×) provide the outer safety net.
  const MAX_ATTEMPTS = 20;
  const DELAY_MS = 30_000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const tag = queryEcr(cfg, expectedPrefix);
    if (tag) {
      console.log(
        `[ecr-tag-resolver] Resolved ${repoName} ${env} tag for SHA ${shortSha}: ${tag}` +
          (attempt > 1 ? ` (after ${attempt} attempts)` : ""),
      );
      return tag;
    }
    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `[ecr-tag-resolver] No tag matching ${expectedPrefix}* in ECR repo ${cfg.ecrRepository} (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${DELAY_MS / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  throw new Error(
    `[ecr-tag-resolver] No ECR image found for ${repoName} ${env} ` +
      `(expected tag prefix '${expectedPrefix}*' in ${cfg.ecrRepository}, ${cfg.region}). ` +
      `CI may not have finished pushing yet, or the build failed. ` +
      `Verify with: aws ecr describe-images --region ${cfg.region} --repository-name ${cfg.ecrRepository}`,
  );
}
