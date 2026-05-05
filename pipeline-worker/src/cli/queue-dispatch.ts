#!/usr/bin/env node
/**
 * queue-dispatch — pull a pending task off the queue and trigger a fresh
 * Forge run for it. The dispatched workflow id is recorded on the queue
 * entry; the entry's status flips to "dispatched".
 *
 * Usage:
 *   node dist/cli/queue-dispatch.js <task-id>
 *
 * The task body becomes the trigger.js instruction. The repo is taken
 * from the originating context if recoverable; otherwise from
 * DEFAULT_REPO_NAME (operator can override via --repo).
 */
import { findTaskById, markTaskDispatched } from '../lib/pending-queue';
import { getTemporalClient } from '../temporal-client';
import { multiTicketWorkflow } from '../workflows/MultiTicketWorkflow';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import { generateWavePlan } from './plan';

(async () => {
  const argv = process.argv.slice(2);
  let taskId: string | undefined;
  let repoName = DEFAULT_REPO_NAME;
  let skipProdDeploy = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') {
      repoName = argv[++i];
    } else if (a === '--skip-prod-deploy') {
      skipProdDeploy = true;
    } else if (!a.startsWith('-')) {
      if (!taskId) taskId = a;
    }
  }
  if (!taskId) {
    process.stderr.write(
      'Usage: queue-dispatch <task-id> [--repo <name>] [--skip-prod-deploy]\n'
    );
    process.exit(2);
  }

  const task = findTaskById(taskId);
  if (!task) {
    process.stderr.write(`No task with id ${taskId}\n`);
    process.exit(3);
  }
  if (task.status !== 'pending') {
    process.stderr.write(
      `Task ${taskId} is in status "${task.status}"; only pending tasks can be dispatched.\n`
    );
    process.exit(4);
  }

  const namespace = process.env.TEMPORAL_NAMESPACE;
  if (!namespace) throw new Error('TEMPORAL_NAMESPACE env var is required');

  const repoConfig = getRepoConfig(repoName);
  const wavePlan = await generateWavePlan(task.body);
  for (const wave of wavePlan.waves) {
    for (const ticket of wave.tickets) {
      ticket.repoName = repoConfig.repoName;
    }
  }

  const client = await getTemporalClient();
  const wfId = `forge-queued-${task.id.slice(0, 8)}-${Date.now()}`;
  const handle = await client.workflow.start(multiTicketWorkflow, {
    workflowId: wfId,
    taskQueue: repoConfig.taskQueue,
    args: [wavePlan, { skipProdDeploy }],
  });

  markTaskDispatched(task.id, wfId);
  process.stdout.write(
    JSON.stringify(
      {
        taskId: task.id,
        dispatchedWorkflowId: wfId,
        runId: handle.firstExecutionRunId,
        repo: repoConfig.repoName,
        options: { skipProdDeploy },
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`queue-dispatch failed: ${msg}\n`);
  process.exit(1);
});
