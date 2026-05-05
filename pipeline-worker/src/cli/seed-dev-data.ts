#!/usr/bin/env node
/**
 * seed-dev-data — operator CLI to invoke a repo's `seedFixturesScript`
 * with the prod-target refusal guard in front of it.
 *
 * Usage:
 *   node dist/cli/seed-dev-data.js --repo <repoName> [--worktree <path>] \
 *     [--host-env-var CLICKHOUSE_HOST]
 *
 * Wraps `seedDevDataActivity` for direct CLI use. The activity itself
 * is also wired in as a workflow activity for future automatic
 * invocation; this CLI is the operator-facing path.
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { seedDevDataActivity } from '../activities/seedDevData';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';

interface Args {
  repoName: string;
  worktreePath: string;
  hostEnvVar?: string;
}

function parseArgs(argv: string[]): Args {
  let repoName = DEFAULT_REPO_NAME;
  let worktreePath = process.cwd();
  let hostEnvVar: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') repoName = argv[++i];
    else if (a === '--worktree') worktreePath = argv[++i];
    else if (a === '--host-env-var') hostEnvVar = argv[++i];
  }
  return { repoName, worktreePath, hostEnvVar };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const repoConfig = getRepoConfig(args.repoName); // throws on bad repo
  if (!existsSync(args.worktreePath)) {
    throw new Error(`Worktree path does not exist: ${args.worktreePath}`);
  }
  if (repoConfig.seedFixturesScript) {
    const scriptPath = join(args.worktreePath, repoConfig.seedFixturesScript);
    if (!existsSync(scriptPath)) {
      console.warn(
        `[seed-dev-data] warning: configured seedFixturesScript '${repoConfig.seedFixturesScript}' not found ` +
        `at ${scriptPath}. The activity will fail when bash tries to source it.`,
      );
    }
  }
  const result = await seedDevDataActivity({
    worktreePath: args.worktreePath,
    repoName: args.repoName,
    hostEnvVar: args.hostEnvVar,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.exitCode === 0 ? 0 : 1);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`seed-dev-data failed: ${msg}\n`);
  process.exit(1);
});
