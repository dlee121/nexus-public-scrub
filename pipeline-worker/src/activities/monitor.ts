import { spawnSync } from 'child_process';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import { addPendingTask } from '../lib/pending-queue';

export interface MonitorResult {
  passed: boolean;
  output: string;
}

/**
 * HTTP health check with retries. Returns once the endpoint returns 2xx,
 * or after the budget is exhausted. Caller decides whether a failure
 * here is fatal — we just report.
 *
 * Budget: 12 attempts × 10s = 2 min. Tuned so a freshly-deployed EB
 * environment gets time to come up (typical EB deploy + warmup is
 * ~60-90s) without excessive waste when the endpoint is already up.
 */
async function pollHealthEndpoint(url: string): Promise<{
  ok: boolean;
  status: number;
  bodyExcerpt: string;
  attempts: number;
}> {
  const MAX_ATTEMPTS = 12;
  const DELAY_MS = 10_000;
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Accept: '*/*' },
        signal: AbortSignal.timeout(8_000),
      });
      lastStatus = resp.status;
      const text = await resp.text().catch(() => '');
      lastBody = text.slice(0, 400);
      if (resp.ok) {
        return { ok: true, status: resp.status, bodyExcerpt: lastBody, attempts: attempt };
      }
    } catch (err) {
      lastBody = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  return { ok: false, status: lastStatus, bodyExcerpt: lastBody, attempts: MAX_ATTEMPTS };
}

/**
 * Post-deploy validation. Three gates, all opt-in per repo via nexus.json:
 *
 *   1. devHealthCheckUrl — HTTP GET against the dev environment, polled
 *      until 2xx or 2-min budget elapsed.
 *   2. smokeCommand — `bash -lc <repoConfig.smokeCommand>` (e.g.
 *      `make smoke-test-containers`). Runs against the freshly-deployed
 *      dev environment. NOT run in VERIFY because the smoke target
 *      typically probes running containers, which a worker worktree
 *      doesn't have — only post-deploy makes sense.
 *   3. monitorScript — `bash <repoConfig.monitorScript>` from the worktree
 *      for repo-specific functional/integration validation.
 *
 * If none are set, this is a no-op success (matches prior behavior so
 * existing repos don't break).
 *
 * On any failure, we also enqueue a follow-up task in the pending queue
 * (lib/pending-queue) so the validation gap doesn't get dropped just
 * because the workflow throws. The thrown error still propagates and
 * fails the pipeline; the queue entry is for operator follow-up.
 */
export async function monitorActivity(params: {
  worktreePath: string;
  repoName?: string;
  // Optional context the caller can pass so a queued follow-up task
  // points back at the originating PR. Both fields are best-effort.
  sourceWorkflowId?: string;
  sourcePr?: string;
}): Promise<MonitorResult> {
  const repoConfig = getRepoConfig(params.repoName ?? DEFAULT_REPO_NAME);
  const script = repoConfig.monitorScript;
  const healthUrl = repoConfig.devHealthCheckUrl;
  const smokeCommand = repoConfig.smokeCommand;

  const sections: string[] = [];

  // Gate 1: HTTP health check.
  if (healthUrl) {
    sections.push(`[monitor] HTTP health check → ${healthUrl}`);
    const result = await pollHealthEndpoint(healthUrl);
    if (!result.ok) {
      const msg =
        `[monitor] HTTP health check failed after ${result.attempts} attempts ` +
        `(last status=${result.status}, body excerpt: ${result.bodyExcerpt})`;
      sections.push(msg);
      const output = sections.join('\n');
      try {
        addPendingTask({
          title: `Post-deploy health-check failure on ${repoConfig.repoName}`,
          body:
            `Forge MONITOR detected an HTTP health-check failure after a successful deploy.\n\n` +
            `URL: ${healthUrl}\n` +
            `Last status: ${result.status}\n` +
            `Attempts: ${result.attempts}\n` +
            `Body excerpt: ${result.bodyExcerpt}\n\n` +
            `Investigate whether the deploy actually rolled out or if a runtime ` +
            `regression made the health endpoint unreachable. If a regression, ` +
            `revert the originating PR or ship a forward fix.`,
          sourceWorkflowId: params.sourceWorkflowId,
          sourcePr: params.sourcePr,
          reason: `MONITOR/healthcheck failure on ${repoConfig.repoName} @ ${healthUrl}`,
        });
      } catch (err) {
        sections.push(
          `[monitor] (also failed to enqueue follow-up task: ${err instanceof Error ? err.message : String(err)})`
        );
      }
      return { passed: false, output };
    }
    sections.push(`[monitor] HTTP health check OK (status=${result.status} after ${result.attempts} attempt(s))`);
  } else {
    sections.push('[monitor] no devHealthCheckUrl configured; skipping HTTP gate');
  }

  // Gate 2: smokeCommand (containers up + responding). Configured per-repo
  // in nexus.json (e.g. `make smoke-test-containers`). Was previously
  // wired into VERIFY but moved here on 2026-05-03 because the smoke
  // target probes running containers — meaningless against a worker
  // worktree, only valid post-deploy. Defensive on missing/empty so
  // nexus.json entries without a smokeCommand don't break.
  if (smokeCommand && smokeCommand.trim()) {
    sections.push(`[monitor] running smokeCommand → bash -lc ${smokeCommand}`);
    const smokeResult = spawnSync('bash', ['-lc', smokeCommand], {
      cwd: params.worktreePath,
      env: { ...process.env, PIPELINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const stdout = smokeResult.stdout ?? '';
    const stderr = smokeResult.stderr ?? '';
    sections.push(stdout, stderr);
    if (smokeResult.status !== 0) {
      try {
        addPendingTask({
          title: `Post-deploy smokeCommand failure on ${repoConfig.repoName}`,
          body:
            `Forge MONITOR ran smokeCommand '${smokeCommand}' after a successful deploy and got a non-zero exit.\n\n` +
            `Exit code: ${smokeResult.status}\n\n` +
            `--- stdout ---\n${stdout.slice(0, 4000)}\n\n` +
            `--- stderr ---\n${stderr.slice(0, 4000)}\n\n` +
            `Smoke probably indicates either a real deployment regression ` +
            `(containers up but misbehaving) or environmental issues that ` +
            `prevent smoke from running cleanly (network/IAM/etc).`,
          sourceWorkflowId: params.sourceWorkflowId,
          sourcePr: params.sourcePr,
          reason: `MONITOR/smokeCommand failure on ${repoConfig.repoName} (exit ${smokeResult.status})`,
        });
      } catch (err) {
        sections.push(
          `[monitor] (also failed to enqueue follow-up task: ${err instanceof Error ? err.message : String(err)})`
        );
      }
      return { passed: false, output: sections.join('\n') };
    }
    sections.push(`[monitor] smokeCommand exit 0`);
  } else {
    sections.push('[monitor] no smokeCommand configured; skipping smoke gate');
  }

  // Gate 3: monitorScript (repo-specific functional/integration validation).
  if (script) {
    sections.push(`[monitor] running monitorScript → bash ${script}`);
    const result = spawnSync('bash', [script], {
      cwd: params.worktreePath,
      env: { ...process.env, PIPELINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    sections.push(stdout, stderr);
    if (result.status !== 0) {
      try {
        addPendingTask({
          title: `Post-deploy monitorScript failure on ${repoConfig.repoName}`,
          body:
            `Forge MONITOR ran ${script} after a successful deploy and got a non-zero exit.\n\n` +
            `Exit code: ${result.status}\n\n` +
            `--- stdout ---\n${stdout.slice(0, 4000)}\n\n` +
            `--- stderr ---\n${stderr.slice(0, 4000)}\n\n` +
            `Investigate whether the failing assertion reflects a real regression ` +
            `or a flaky check that needs the script tightened.`,
          sourceWorkflowId: params.sourceWorkflowId,
          sourcePr: params.sourcePr,
          reason: `MONITOR/monitorScript failure on ${repoConfig.repoName} (exit ${result.status})`,
        });
      } catch (err) {
        sections.push(
          `[monitor] (also failed to enqueue follow-up task: ${err instanceof Error ? err.message : String(err)})`
        );
      }
      return { passed: false, output: sections.join('\n') };
    }
    sections.push(`[monitor] monitorScript exit 0`);
  } else {
    sections.push('[monitor] no monitorScript configured; skipping functional gate');
  }

  // Both gates passed (or were skipped because unset). Treat as success.
  return { passed: true, output: sections.join('\n') };
}
