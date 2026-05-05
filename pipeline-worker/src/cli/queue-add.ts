#!/usr/bin/env node
/**
 * queue-add — append a follow-up task to the Forge pending queue.
 *
 * Usage:
 *   node dist/cli/queue-add.js --title "..." --body "..." \
 *       [--source-workflow <id>] [--source-pr <url-or-number>] [--reason "..."]
 *
 * Bodies are passed as a single arg per the trigger.js convention.
 */
import { addPendingTask } from '../lib/pending-queue';

interface Args {
  title?: string;
  body?: string;
  sourceWorkflowId?: string;
  sourcePr?: string;
  reason?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--title') out.title = next();
    else if (a === '--body') out.body = next();
    else if (a === '--source-workflow') out.sourceWorkflowId = next();
    else if (a === '--source-pr') out.sourcePr = next();
    else if (a === '--reason') out.reason = next();
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.title || !args.body) {
    process.stderr.write(
      'Usage: queue-add --title "..." --body "..." ' +
      '[--source-workflow <id>] [--source-pr <url>] [--reason "..."]\n'
    );
    process.exit(2);
  }
  const task = addPendingTask({
    title: args.title,
    body: args.body,
    sourceWorkflowId: args.sourceWorkflowId,
    sourcePr: args.sourcePr,
    reason: args.reason,
  });
  process.stdout.write(JSON.stringify(task, null, 2) + '\n');
  process.exit(0);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`queue-add failed: ${msg}\n`);
  process.exit(1);
});
