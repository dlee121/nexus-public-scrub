#!/usr/bin/env node
/**
 * queue-list — print the Forge pending queue.
 *
 * Usage:
 *   node dist/cli/queue-list.js                 # all tasks
 *   node dist/cli/queue-list.js --status pending
 *   node dist/cli/queue-list.js --json          # raw JSON instead of summary
 */
import {
  listPendingTasks,
  type PendingTaskStatus,
  type PendingTask,
} from '../lib/pending-queue';

const VALID_STATUSES: PendingTaskStatus[] = [
  'pending',
  'dispatched',
  'completed',
  'completed-no-action',
];

function parseArgs(argv: string[]): {
  status?: PendingTaskStatus;
  asJson: boolean;
} {
  let status: PendingTaskStatus | undefined;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') {
      const v = argv[++i] as PendingTaskStatus;
      if (!VALID_STATUSES.includes(v)) {
        throw new Error(
          `--status must be one of: ${VALID_STATUSES.join(', ')}`
        );
      }
      status = v;
    } else if (a === '--json') {
      asJson = true;
    }
  }
  return { status, asJson };
}

function formatSummary(tasks: PendingTask[]): string {
  if (tasks.length === 0) return '(no tasks)\n';
  const lines = tasks.map((t) => {
    const head = `[${t.status.toUpperCase()}] ${t.id.slice(0, 8)}  ${t.title}`;
    const meta: string[] = [];
    if (t.sourcePr) meta.push(`pr=${t.sourcePr}`);
    if (t.sourceWorkflowId) meta.push(`src=${t.sourceWorkflowId}`);
    if (t.dispatchedWorkflowId) meta.push(`dispatched=${t.dispatchedWorkflowId}`);
    meta.push(`created=${t.createdAt}`);
    return head + '\n  ' + meta.join('  ') + (t.reason ? `\n  reason: ${t.reason}` : '');
  });
  return lines.join('\n\n') + '\n';
}

(async () => {
  const { status, asJson } = parseArgs(process.argv.slice(2));
  const tasks = listPendingTasks({ status });
  if (asJson) {
    process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
  } else {
    process.stdout.write(formatSummary(tasks));
  }
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`queue-list failed: ${msg}\n`);
  process.exit(1);
});
