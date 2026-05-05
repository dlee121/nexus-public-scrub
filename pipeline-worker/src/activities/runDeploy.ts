import { spawn } from 'child_process';
import { Context } from '@temporalio/activity';
import {
  ElasticBeanstalkClient,
  DescribeEnvironmentHealthCommand,
} from '@aws-sdk/client-elastic-beanstalk';
import { prepareDeployCheckout } from '../lib/deploy';
import { resolveDeployCommand } from '../lib/deploy-commands';
import { resolveImageTagForRepo } from '../lib/ecr-tag-resolver';
import { getCommitFiles } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { DeployedVersion } from '../types';

/**
 * Conservative deny-list: paths that, when changed *exclusively*, do not
 * produce a deployable artifact. Mirrors the predicate in
 * activities/devDeploy.ts — kept in sync intentionally; both deploy paths
 * (DEV_DEPLOY via devDeployActivity, PROD_DEPLOY via runDeployActivity)
 * must short-circuit identically when CI never built a Docker image, or
 * the ecr-tag-resolver will spin until it exhausts its retry budget.
 *
 * Anything outside this set defaults to "deploy" — false negatives waste
 * a deploy cycle, false positives skip a needed deploy, so we err toward
 * deploying.
 */
function isNonDeployablePath(path: string): boolean {
  if (path.startsWith('.github/')) return true;
  if (path.startsWith('docs/')) return true;
  if (path.endsWith('.md')) return true;
  if (path.endsWith('.rst')) return true;
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

// Heartbeat cadence — 30 s gives the workflow visibility into hangs without
// flooding Temporal. Workflow-side `heartbeatTimeout` should be at least 2x
// this so a single missed beat doesn't fail the activity.
const HEARTBEAT_INTERVAL_MS = 30_000;
// EB env-health poll cadence + ceiling. AWS surfaces transition states
// (Launching → Updating → Ready) on the order of 30–90 s; 15 s is fine
// granularity. 5 min ceiling: deploys that succeed at the EB API layer but
// fail to converge typically stall on a misbehaving instance health check;
// non-fatal because runDeployActivity's job is "tell EB to deploy", not
// "guarantee fleet health" — that's MONITOR's territory.
const EB_POLL_INTERVAL_MS = 15_000;
const EB_POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * Run the deploy command via streamed spawn so we can heartbeat Temporal
 * every {@link HEARTBEAT_INTERVAL_MS} with elapsed time + the most recent
 * non-empty log line. Output is mirrored to the worker's stdout/stderr so
 * the existing `journalctl -u forge-worker` view is preserved.
 *
 * Heartbeat payload shape is intentionally small (a string + a number) —
 * Temporal records it on every heartbeat and the dashboard surfaces it
 * via heartbeatDetails on activity descriptions.
 */
async function runDeployCommandStreaming(opts: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ status: number; lastLog: string; durationMs: number }> {
  const ctx = Context.current();
  const start = Date.now();
  let lastLog = '';

  const child = spawn('bash', ['-lc', opts.command], {
    cwd: opts.cwd,
    env: opts.env,
  });

  // Mirror to the worker's own stdio (preserves existing journal output)
  // AND track the last non-empty trimmed line for heartbeat payloads.
  // Buffering by line within a chunk handles the common case where a make
  // recipe emits multiple lines per write; a single line spanning two
  // chunks loses the prefix in the lastLog read, but heartbeat consumers
  // already treat lastLog as a hint, not a contract.
  const trackChunk = (chunk: Buffer, sink: NodeJS.WriteStream): void => {
    sink.write(chunk);
    for (const line of chunk.toString('utf-8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lastLog = trimmed;
    }
  };
  child.stdout.on('data', (chunk: Buffer) => trackChunk(chunk, process.stdout));
  child.stderr.on('data', (chunk: Buffer) => trackChunk(chunk, process.stderr));

  const heartbeatTimer = setInterval(() => {
    const elapsedMs = Date.now() - start;
    // truncate lastLog so the recorded heartbeat detail stays small —
    // Temporal logs every heartbeat and a multi-KB log line bloats the
    // history. 240 chars covers the typical "X-of-Y instances OK" type
    // status line.
    ctx.heartbeat({
      phase: 'deploy-cmd',
      elapsedMs,
      lastLog: lastLog.slice(0, 240),
    });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const status: number = await new Promise((resolve) => {
      // 'close' fires after stdio streams flush; 'exit' can fire before.
      // Using 'close' avoids a race where the heartbeat timer is cleared
      // before the final stderr line is recorded into lastLog.
      child.on('close', (code) => resolve(code ?? -1));
      child.on('error', (err) => {
        process.stderr.write(`[runDeploy] spawn error: ${err.message}\n`);
        resolve(-1);
      });
    });
    return { status, lastLog, durationMs: Date.now() - start };
  } finally {
    clearInterval(heartbeatTimer);
  }
}

/**
 * Poll Elastic Beanstalk environment health until it converges or we hit
 * {@link EB_POLL_TIMEOUT_MS}. Three outcomes:
 *
 *   - `ok=true`  — env reached Status=Ready with HealthStatus in {Ok, Info}.
 *   - `ok=false, fatal=true` — env reported HealthStatus=Severe or
 *     Status=Terminating/Terminated. Caller throws.
 *   - `ok=false, fatal=false` — timed out without converging. Caller logs
 *     a warning and treats the deploy as successful (the deploy *command*
 *     succeeded; convergence stall is MONITOR's domain, not ours).
 *
 * EB attribute reference (boto3 docs / AWS API):
 *   Status:        Launching | Updating | Ready | Terminating | Terminated
 *   HealthStatus:  NoData | Unknown | Pending | Ok | Info | Warning |
 *                  Degraded | Severe
 *
 * Errors from the AWS SDK (credentials missing, env not found, throttle)
 * are surfaced to the caller as a non-fatal warning — the deploy command
 * itself succeeded, so we don't fail the activity over an observability
 * gap.
 */
async function pollEbEnvironmentHealth(opts: {
  envName: string;
  region: string;
}): Promise<{ ok: boolean; fatal: boolean; reason: string }> {
  const client = new ElasticBeanstalkClient({ region: opts.region });
  const ctx = Context.current();
  const start = Date.now();
  let lastStatus = '';
  let lastHealthStatus = '';

  while (Date.now() - start < EB_POLL_TIMEOUT_MS) {
    let result;
    try {
      result = await client.send(
        new DescribeEnvironmentHealthCommand({
          EnvironmentName: opts.envName,
          AttributeNames: ['Status', 'HealthStatus'],
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // AWS API error — non-fatal. Caller logs and proceeds.
      return {
        ok: false,
        fatal: false,
        reason: `DescribeEnvironmentHealth threw: ${msg}`,
      };
    }
    lastStatus = result.Status ?? '';
    lastHealthStatus = result.HealthStatus ?? '';

    // Success: env is Ready and health is Ok or Info (Info = "Operational
    // notice posted, no action required" — still a healthy state).
    if (
      lastStatus === 'Ready' &&
      (lastHealthStatus === 'Ok' || lastHealthStatus === 'Info')
    ) {
      return {
        ok: true,
        fatal: false,
        reason: `Status=${lastStatus} HealthStatus=${lastHealthStatus}`,
      };
    }
    // Fail-fast: severe health or env shutting down.
    if (
      lastHealthStatus === 'Severe' ||
      lastStatus === 'Terminating' ||
      lastStatus === 'Terminated'
    ) {
      return {
        ok: false,
        fatal: true,
        reason: `Status=${lastStatus} HealthStatus=${lastHealthStatus}`,
      };
    }

    ctx.heartbeat({
      phase: 'eb-health-poll',
      elapsedMs: Date.now() - start,
      envName: opts.envName,
      status: lastStatus,
      healthStatus: lastHealthStatus,
    });

    await new Promise((r) => setTimeout(r, EB_POLL_INTERVAL_MS));
  }

  return {
    ok: false,
    fatal: false,
    reason: `Did not converge in ${EB_POLL_TIMEOUT_MS / 1000}s (last: Status=${lastStatus} HealthStatus=${lastHealthStatus})`,
  };
}

export async function runDeployActivity(
  env: 'dev' | 'prod',
  ticket: { ticketId: string; mergeSha: string; enqueuedAt: number; repoName?: string },
): Promise<DeployedVersion> {
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);

  if (repoConfig.autoDeploy === true) {
    console.log(
      `[runDeploy:${env}] Skipping for ${repoConfig.repoName} (autoDeploy=true)`,
    );
    return {
      env,
      intendedSha: ticket.mergeSha,
      deployedSha: ticket.mergeSha,
      localCommitCreated: false,
      deployedTag: ticket.ticketId,
      ebVersionLabel: ticket.mergeSha.slice(0, 12),
      timestamp: new Date().toISOString(),
    };
  }

  // Skip when the merge touched only non-deployable paths (docs/.github/etc).
  // CI never built a Docker image for these merges, so resolveImageTagForRepo
  // would loop until it exhausted its retry budget. Mirrors the equivalent
  // skip in devDeployActivity. Best-effort: any failure listing files
  // defaults to "deploy" so we never accidentally swallow a real deploy.
  try {
    const files = await getCommitFiles({
      owner: repoConfig.repoOwner,
      repo: repoConfig.repoName,
      sha: ticket.mergeSha,
    });
    if (files.length > 0 && files.every(isNonDeployablePath)) {
      console.log(
        `[runDeploy:${env}] Skipping for ${repoConfig.repoName} @ ${ticket.mergeSha.slice(0, 12)} ` +
        `— merge touched only non-deployable paths (${files.length} files: ` +
        `${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}). ` +
        `No Docker image built; nothing to deploy.`,
      );
      return {
        env,
        intendedSha: ticket.mergeSha,
        deployedSha: ticket.mergeSha,
        localCommitCreated: false,
        deployedTag: ticket.ticketId,
        ebVersionLabel: ticket.mergeSha.slice(0, 12),
        timestamp: new Date().toISOString(),
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[runDeploy:${env}] getCommitFiles failed for ${ticket.mergeSha.slice(0, 12)} (${msg}); ` +
      `proceeding with deploy as if app code changed.`,
    );
  }

  const checkoutPath = prepareDeployCheckout({
    repoOwner: repoConfig.repoOwner,
    repoName: repoConfig.repoName,
    targetSha: ticket.mergeSha,
  });

  // Resolve via the canonical-commands helper so realtime-platform's
  // tagged-EB targets stay locked to source even if nexus.json drifts.
  const configured =
    env === 'dev' ? repoConfig.deployDevCommand : repoConfig.deployProdCommand;
  const deployCommand = resolveDeployCommand(repoConfig.repoName, env, configured);

  // For repos that build images on CI and have Forge invoke a deploy-only
  // make recipe (currently just [target-repo-realtime] via the
  // SKIP_ECR_PUSH=1 prefix), Forge must supply the IMAGE_TAG since the
  // worktree is freshly cloned and has no .deployment-tag-{env}. Repos
  // not in the registry get a null and their deploy command runs unchanged.
  const imageTag = await resolveImageTagForRepo(repoConfig.repoName, env, ticket.mergeSha);

  // Streamed spawn with periodic Temporal heartbeats. Workflow-side proxy
  // sets heartbeatTimeout to 90s; one missed beat is tolerated, two in a
  // row trip the timeout and force a retry.
  const { status, lastLog, durationMs } = await runDeployCommandStreaming({
    command: deployCommand,
    cwd: checkoutPath,
    env: {
      ...process.env,
      PIPELINE: '1',
      ...(imageTag ? { IMAGE_TAG: imageTag } : {}),
    },
  });

  if (status !== 0) {
    throw new Error(
      `${env} deploy failed (repo: ${repoConfig.repoName}, ticketId: ${ticket.ticketId}, ` +
      `SHA: ${ticket.mergeSha}, cmd: ${deployCommand}${imageTag ? `, IMAGE_TAG: ${imageTag}` : ''}, ` +
      `exitStatus=${status}, durationMs=${durationMs}, lastLog="${lastLog.slice(0, 200)}")`,
    );
  }

  // Post-deploy EB health convergence check. The deploy command returned
  // 0, but EB's update is asynchronous — instances may still be cycling.
  // We poll until Ready+Ok/Info (success), Severe/Terminated (fail fast),
  // or 5 min (warn but treat as success — convergence stall is MONITOR's
  // domain). Resolved env name comes from the per-repo config; AWS region
  // reuses repoConfig.codeartifact.region (every Forge repo deploys in
  // the same region as its CodeArtifact endpoint today). Missing config
  // → skip the poll with a warn so an unconfigured repo still deploys.
  const envName =
    env === 'dev' ? repoConfig.devEnvironment : repoConfig.prodEnvironment;
  const region = repoConfig.codeartifact?.region ?? '';

  if (!envName || !region) {
    console.warn(
      `[runDeploy:${env}] EB health-poll skipped — ` +
      `${!envName ? `${env}Environment` : 'codeartifact.region'} not set in nexus.json for ` +
      `${repoConfig.repoName}.`,
    );
  } else {
    const health = await pollEbEnvironmentHealth({ envName, region });
    if (health.ok) {
      console.log(
        `[runDeploy:${env}] EB env ${envName} healthy: ${health.reason}`,
      );
    } else if (health.fatal) {
      throw new Error(
        `${env} deploy command succeeded but EB env ${envName} reported ` +
        `unrecoverable health: ${health.reason} (repo: ${repoConfig.repoName}, ` +
        `ticketId: ${ticket.ticketId}, SHA: ${ticket.mergeSha})`,
      );
    } else {
      // Non-fatal: deploy command succeeded, convergence didn't complete in
      // 5 min OR AWS API itself failed. Don't block the workflow on it.
      console.warn(
        `[runDeploy:${env}] EB env ${envName} did not converge: ${health.reason}. ` +
        `Treating as success (deploy command exited 0).`,
      );
    }
  }

  return {
    env,
    intendedSha: ticket.mergeSha,
    deployedSha: ticket.mergeSha,
    localCommitCreated: false,
    deployedTag: ticket.ticketId,
    ebVersionLabel: ticket.mergeSha.slice(0, 12),
    timestamp: new Date().toISOString(),
  };
}
