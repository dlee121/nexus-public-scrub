#!/usr/bin/env node
import { getTemporalClient } from '../temporal-client';
import { multiTicketWorkflow } from '../workflows/MultiTicketWorkflow';
import { DEFAULT_REPO_NAME, getAllRepoConfigs, getRepoConfig } from '../config';
import { slugify } from '../lib/slug';
import { generateWavePlan } from './plan';
import { applyRepoFallback } from './trigger-helpers';

/**
 * Strip `--repo=<name>` (or `--repo <name>`) and `--skip-prod-deploy`
 * from positional args; return { instruction, repoName, skipProdDeploy }.
 * Keeps the call site simple — no full commander/yargs needed for two
 * optional flags.
 */
function parseArgs(argv: string[]): {
  instruction: string | undefined;
  repoName: string;
  skipProdDeploy: boolean;
} {
  const args = [...argv];
  let repoName = DEFAULT_REPO_NAME;
  let skipProdDeploy = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--repo' && i + 1 < args.length) {
      repoName = args[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--repo=')) {
      repoName = a.slice('--repo='.length);
      continue;
    }
    if (a === '--skip-prod-deploy') {
      skipProdDeploy = true;
      continue;
    }
    positional.push(a);
  }
  return { instruction: positional[0], repoName, skipProdDeploy };
}

(async () => {
  const { instruction, repoName, skipProdDeploy } = parseArgs(process.argv.slice(2));
  if (!instruction || !instruction.trim()) {
    const known = Object.keys(getAllRepoConfigs()).join(', ');
    throw new Error(
      [
        `Usage: node dist/cli/trigger.js [--repo <name>] [--skip-prod-deploy] "<instruction>"`,
        ``,
        `--repo <name>           Fallback repo for any tickets the planner does not`,
        `                        assign. Most invocations should let the planner`,
        `                        choose per-ticket — the flag is kept as a legacy`,
        `                        escape hatch for single-repo workflows.`,
        ``,
        `--skip-prod-deploy      Bypass PROD_DEPLOY_GATE entirely. After MONITOR`,
        `                        succeeds, the workflow ends with state=DONE.`,
        `                        Use for dogfooding the full pipeline without`,
        `                        actually shipping to prod.`,
        ``,
        `Known repos: ${known}`,
      ].join('\n'),
    );
  }

  const namespace = process.env.TEMPORAL_NAMESPACE;
  if (!namespace) {
    throw new Error('TEMPORAL_NAMESPACE env var is required');
  }

  // Validate the fallback-repo before we burn an OpenAI plan call. The
  // planner now emits per-ticket repoName; the resolved repoConfig
  // below is only used as a fallback when the planner omits it.
  const repoConfig = getRepoConfig(repoName);
  const validRepoNames = new Set(Object.keys(getAllRepoConfigs()));

  const wavePlan = await generateWavePlan(instruction);

  // Respect-then-fallback. The planner is the source of truth for
  // ticket→repo assignment; `--repo` only kicks in when the planner
  // omits it (legacy single-repo runs). Validates every resolved name
  // against the registry — defense-in-depth on top of the planner's
  // own assertTicket validation.
  applyRepoFallback(wavePlan, repoConfig.repoName, validRepoNames);

  const client = await getTemporalClient();
  // Descriptive workflow ID: `forge-<slug>-<ts>`. The slug is derived
  // from the instruction so the dashboard can show a human-readable
  // headline without an extra Temporal query. Timestamp suffix keeps
  // IDs unique across runs of the same instruction.
  const slug = slugify(instruction, 40);
  const workflowId = `forge-${slug}-${Date.now()}`;

  // Parent runs on the shared `forge-pipeline` queue. Children also go
  // there (hardcoded in MultiTicketWorkflow.executeChild). repoConfig's
  // own taskQueue is used as a hint but, today, all three repos use the
  // shared queue — a future per-repo queue split would need worker.ts
  // to subscribe to the union, not just `forge-pipeline`.
  const handle = await client.workflow.start(multiTicketWorkflow, {
    args: [wavePlan, { skipProdDeploy }],
    taskQueue: repoConfig.taskQueue,
    workflowId,
  });

  const temporalUrl = `https://cloud.temporal.io/namespaces/${namespace}/workflows/${handle.workflowId}`;

  process.stdout.write(
    JSON.stringify(
      {
        workflowId: handle.workflowId,
        temporalUrl,
        repo: repoConfig.repoName,
        options: { skipProdDeploy },
        plan: wavePlan,
      },
      null,
      2,
    ) + '\n',
  );

  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`forge-trigger failed: ${msg}\n`);
  process.exit(1);
});
