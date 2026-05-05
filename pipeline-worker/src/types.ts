export interface Ticket {
  id: string;           // Linear ticket ID, e.g., "LIN-201"
  title: string;
  description: string;
  acceptanceCriteria: string[];
  rationale?: string;
  // Forge multi-repo: which target repo this ticket belongs to. Resolved
  // against forge.repos in nexus.json. Optional for backward compat —
  // activities that need a repo config call getRepoConfig(repoName) with
  // a fallback to DEFAULT_REPO_NAME ('[target-repo-realtime]').
  repoName?: string;
}

export interface WavePlan {
  instruction: string;
  waves: Array<{ wave: number; tickets: Ticket[] }>;
}

/**
 * Per-run options threaded from the workflow launcher through both
 * `multiTicketWorkflow` and each child `pipelineWorkflow`. Distinct from
 * `Ticket` and `WavePlan` because these are operator-flavored launch-time
 * choices, not part of the plan itself.
 *
 * Add fields conservatively: every field must be optional + have a sane
 * default so older workflows started without options still validate
 * (signal/query handlers have to tolerate `undefined`).
 */
export interface WorkflowOptions {
  /**
   * Skip PROD_DEPLOY_GATE → PROD_DEPLOY entirely. After a successful
   * MONITOR, the workflow transitions straight to DONE. Use case:
   * dogfooding the full pipeline without actually shipping to prod.
   *
   * Distinct from `prodRejectedSignal` which is an *interactive* operator
   * decision at the gate. `skipProdDeploy` decides at workflow-start time
   * that there's no gate at all — quieter, no Slack ping for the gate.
   */
  skipProdDeploy?: boolean;
}

export type PipelineState =
  | 'QUEUED' | 'ANALYZING' | 'PLANNING' | 'PLAN_REVIEW'
  | 'CREATE_TICKETS' | 'IMPLEMENT' | 'APPROVAL_WAIT'
  | 'VERIFY' | 'PR_OPEN' | 'CI_WAIT'
  | 'REVIEW' | 'ADDRESS_REVIEW'
  | 'BUGBOT_WAIT' // @deprecated — replaced by REVIEW. Kept in the union so dashboard queries on historical workflows (e.g. pipeline-TKT-001) still type-check; never set by current code.
  | 'MERGE_QUEUE'
  | 'DEV_DEPLOY' | 'WAIT_FOR_COVERING_DEPLOY'
  | 'MONITOR'
  | 'PROD_DEPLOY_GATE' | 'PROD_DEPLOY'
  | 'DONE' | 'BLOCKED' | 'FAILED' | 'CANCELLED';

/**
 * PR metadata exposed to the dashboard via `currentPrQuery`. Populated
 * after `createPRActivity` returns; null until then. The `state` field
 * is fetched live by the dashboard via the GitHub API — the workflow
 * doesn't poll it. Workflow only owns the static identifiers.
 */
export interface PrInfo {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  /** Repo full name "owner/repo" so the dashboard can fetch PR state. */
  repoFullName: string;
  /** PR head sha at PR open. May be stale after ADDRESS_REVIEW pushes. */
  headSha: string;
}

export interface PipelineConfig {
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  taskQueue: string;
  lintCommand: string;
  /**
   * Optional diff-aware lint command. When set, VERIFY runs the linter
   * only against files changed in the current branch (computed via
   * `git diff --name-only --diff-filter=ACMR <defaultBranch>...HEAD`)
   * instead of the whole worktree. This isolates Forge runs from the
   * pre-existing-error baseline of large codebases (e.g. [target-repo-web]'s
   * ~1k legacy ESLint errors that have nothing to do with the current
   * ticket's diff).
   *
   * The configured value is invoked as a shell command with the
   * filtered file list appended as positional args, e.g.
   *   `npx eslint <file1> <file2> ...`
   * Use `lintDiffExtensions` to whitelist file types the linter knows
   * how to parse — without it, README.md in the diff would be passed
   * to ESLint and fail with a parser error.
   *
   * When unset, VERIFY falls back to the legacy whole-repo `lintCommand`.
   */
  lintDiffCommand?: string;
  /**
   * Extension whitelist (lowercase, with the leading dot) used to
   * filter the changed-file list before invoking `lintDiffCommand`.
   * Files outside this set are excluded. Empty/undefined means "pass
   * all changed files" — only correct when the linter natively
   * tolerates non-source files. Recommended for any repo that opts
   * into `lintDiffCommand`.
   */
  lintDiffExtensions?: string[];
  testCommand: string;
  /**
   * Optional diff-aware test command. When set, VERIFY runs tests scoped
   * to files changed in the current branch (computed via
   * `git diff --name-only --diff-filter=ACMR <defaultBranch>...HEAD`)
   * instead of the whole suite. Mirrors `lintDiffCommand` and exists for
   * the same reason — insulating Forge from pre-existing failure baselines
   * in large repos (e.g. [target-repo-api]'s ~50 network/external-service
   * tests that fail in the worker sandbox regardless of the diff).
   *
   * Invoked as `<testDiffCommand> <file1> <file2> ...`. When the diff
   * touches no files matching `testDiffExtensions`, the test step is a
   * no-op success — VERIFY answers only for what the branch changed; the
   * full battery still runs in CI on the PR downstream.
   *
   * Caveat: a source-only change runs zero tests under this mode (the
   * source file is in the diff, but no test file is). That's acceptable
   * for VERIFY's role as a fast pre-PR gate; CI is authoritative.
   *
   * When unset, VERIFY falls back to the legacy whole-repo `testCommand`.
   */
  testDiffCommand?: string;
  /**
   * Extension whitelist (lowercase, with the leading dot) used to filter
   * the changed-file list before invoking `testDiffCommand`. Same shape
   * and semantics as `lintDiffExtensions`.
   */
  testDiffExtensions?: string[];
  smokeCommand: string;
  deployDevCommand: string;
  deployProdCommand: string;
  devEnvironment: string;
  prodEnvironment: string;
  /**
   * @deprecated Was the GitHub login (`cursor[bot]`) Forge polled in BUGBOT_WAIT.
   * Replaced by REVIEW + ADDRESS_REVIEW. Field kept optional so existing
   * nexus.json entries don't fail validation; remove once all repo configs
   * have been cleaned up.
   */
  bugbotAuthorLogin?: string;
  /**
   * One-sentence description of what the repo is. Surfaced to the planner
   * so it can assign each ticket to exactly one repo. Optional for
   * backward compat; missing description means the repo shows up in the
   * catalog with `(no description)`.
   */
  description?: string;
  claudeMdPath: string;
  agentsMdPath: string;
  codeartifact: {
    domain: string;
    domainOwner: string;
    region: string;
    repository: string;
  };
  // Optional: secondary type-check command run by VERIFY after lint.
  // Only the realtime-platform repo currently has a `make ty-check` target;
  // omit for repos without one and verify will skip it.
  tyCheckCommand?: string;
  // Optional: best-effort auto-fix command (e.g. `make fix`, `npm run fix`)
  // run before lint to clean up trivial formatting issues from CC sessions.
  // Failures are swallowed silently so a missing target is harmless.
  fixCommand?: string;
  // When true, the workflow skips DEV_DEPLOY entirely. Use for repos that
  // auto-deploy on push to main (e.g. Render, Vercel) — there's nothing for
  // Forge to do at deploy time. The PR merge IS the deploy trigger.
  autoDeploy?: boolean;
  // Optional path (relative to the repo root) of a post-deploy validation
  // script. MONITOR runs `bash <monitorScript>` from the worktree; non-zero
  // exit fails the pipeline. When unset (the default), MONITOR is a no-op
  // success. Decoupled from autoDeploy on purpose: a repo can have
  // autoDeploy=true (Forge skips deploy) AND a meaningful health check
  // (e.g., poll a /health endpoint after merge). Add the script to the
  // target repo first, then set this field.
  monitorScript?: string;
  // Optional HTTP endpoint that MONITOR polls for a 2xx response after
  // deploy succeeds. Polled with retries before falling through to the
  // monitorScript (if set). Universal post-deploy gate — every repo
  // should have one even if monitorScript is empty. Format: full URL
  // including scheme (e.g. "https://dev.example.com/health").
  devHealthCheckUrl?: string;
  // Optional path (relative to the repo root) of a script that seeds
  // dev-environment fixtures (typically into the dev ClickHouse). Used
  // when validation needs minimum data Forge can't expect to find
  // organically. The script must be idempotent — running it twice on
  // the same dev environment produces no extra rows.
  //
  // Hard safety: the activity refuses to invoke this script unless the
  // CLICKHOUSE_HOST (or equivalent target var named in the script) is
  // verified to be a dev/staging host. The seed script itself should
  // also re-validate the target before any write.
  seedFixturesScript?: string;
}

export interface ForgeConfig {
  pipeline: PipelineConfig;
}

export interface DeployedVersion {
  env: 'dev' | 'prod';
  intendedSha: string;
  deployedSha: string;
  localCommitCreated: boolean;
  deployedTag: string;
  ebVersionLabel: string;
  timestamp: string;
}
