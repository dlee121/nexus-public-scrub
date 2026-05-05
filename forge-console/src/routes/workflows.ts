import { Hono } from 'hono';
import { getTemporalClient } from '../temporal.ts';
import { classifyState, extractTicketId } from '../state/classify.ts';
import type {
  WorkflowCard,
  WorkflowsResponse,
  WorkflowDetail,
  WavePlan,
  PrInfoCard,
  WorkflowOptionsCard,
} from '../types.ts';

// Wire shape returned by the worker's `currentPrQuery`. Mirrors
// PrInfo in pipeline-worker/src/types.ts. Kept local to avoid a
// cross-package source import.
interface WorkerPrInfo {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  repoFullName: string;
  headSha: string;
}

const TASK_QUEUE = 'forge-pipeline';
const LIST_LIMIT = 100;

/**
 * Slug helper — mirrors `pipeline-worker/src/lib/slug.ts`. Inlined here
 * so this package stays freestanding (no cross-package source imports).
 * Pure function; safe to call from any route handler.
 */
function slugify(input: string, maxLen: number = 40): string {
  const normalized = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) return 'task';
  if (normalized.length <= maxLen) return normalized;
  const hardCut = normalized.slice(0, maxLen);
  const lastDash = hardCut.lastIndexOf('-');
  if (lastDash >= maxLen * 0.6) return hardCut.slice(0, lastDash);
  return hardCut.replace(/-+$/, '');
}

export const workflowsRoutes = new Hono();

/**
 * Create a Forge multi-ticket workflow from a pre-built wave plan.
 *
 * Why pre-built: the planner runs against OpenAI and lives in the
 * pipeline-worker package alongside the heavy SDK deps. Keeping the
 * console freestanding means the caller (CLI today, UI eventually)
 * generates the plan and POSTs the result. The endpoint validates the
 * plan shape shallowly, picks a descriptive workflow ID, and hands off
 * to Temporal. Anything plan-validation-shaped (per-ticket repo names,
 * acceptance-criteria coverage) is the caller's responsibility.
 *
 * Body shape:
 *   {
 *     "wavePlan":     <WavePlan>          // required
 *     "options":      <WorkflowOptions>   // optional, e.g. { "skipProdDeploy": true }
 *     "taskQueue":    string              // optional, defaults to "forge-pipeline"
 *     "workflowId":   string              // optional override
 *   }
 *
 * Returns 200 with `{ workflowId, runId }` on success, 400 on bad body,
 * 500 on Temporal start failure.
 */
workflowsRoutes.post('/', async (c) => {
  let body: {
    wavePlan?: WavePlan;
    options?: WorkflowOptionsCard;
    taskQueue?: string;
    workflowId?: string;
  };
  try {
    body = await c.req.json();
  } catch (err) {
    return c.json(
      { ok: false, error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
      400,
    );
  }

  const wavePlan = body.wavePlan;
  if (
    !wavePlan ||
    typeof wavePlan.instruction !== 'string' ||
    !Array.isArray(wavePlan.waves) ||
    wavePlan.waves.length === 0
  ) {
    return c.json(
      {
        ok: false,
        error:
          'Body must include a `wavePlan` with `instruction: string` and a non-empty `waves` array.',
      },
      400,
    );
  }

  const options: WorkflowOptionsCard = body.options ?? {};
  // Reject unknown option keys so a typo (e.g. "skip_prod_deploy") fails
  // loudly instead of silently being ignored on a long-running workflow.
  const knownOptionKeys = new Set(['skipProdDeploy']);
  const unknownOptionKeys = Object.keys(options).filter(
    (k) => !knownOptionKeys.has(k),
  );
  if (unknownOptionKeys.length > 0) {
    return c.json(
      {
        ok: false,
        error: `Unknown option keys: ${unknownOptionKeys.join(', ')}. Known: ${[...knownOptionKeys].join(', ')}.`,
      },
      400,
    );
  }

  const taskQueue = body.taskQueue ?? TASK_QUEUE;
  const slug = slugify(wavePlan.instruction);
  const workflowId = body.workflowId ?? `forge-${slug}-${Date.now()}`;

  const client = await getTemporalClient();
  try {
    // Use the workflow type by name string — keeps this package
    // freestanding from pipeline-worker source. The worker has
    // `multiTicketWorkflow` registered at module load time; Temporal
    // matches by name on the wire.
    const handle = await client.workflow.start('multiTicketWorkflow', {
      workflowId,
      taskQueue,
      args: [wavePlan, options],
    });
    return c.json({
      ok: true,
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
      taskQueue,
      options,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: `workflow.start failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }
});

/**
 * List workflows on the Forge task queue, classified into three buckets by
 * app-level state (queried via currentStateQuery on each running workflow).
 * Closed workflows fall back to the Temporal execution status.
 */
workflowsRoutes.get('/', async (c) => {
  const client = await getTemporalClient();
  const response: WorkflowsResponse = {
    needsApproval: [],
    running: [],
    done: [],
    failed: [],
    refreshedAt: new Date().toISOString(),
  };

  // First pass — collect raw executions so we can do parent-linkage in
  // a second pass without re-listing. The list API yields lazily; cap at
  // LIST_LIMIT to bound the work.
  type RawExec = {
    workflowId: string;
    type: string;
    statusName: string;
    startTime: Date | null;
    parentExecutionId: string | null;
  };
  const raw: RawExec[] = [];
  let count = 0;
  for await (const execution of client.workflow.list({
    query: `TaskQueue="${TASK_QUEUE}"`,
  })) {
    if (count >= LIST_LIMIT) break;
    count++;
    // The SDK's WorkflowExecutionInfo exposes `parentExecution` on
    // recent versions (proto-derived, optional). Read defensively —
    // an older SDK or a workflow that wasn't started as a child will
    // yield undefined. Falls back to the time-window heuristic below.
    const parentExecutionId =
      (execution as unknown as { parentExecution?: { workflowId?: string } })
        .parentExecution?.workflowId ?? null;
    raw.push({
      workflowId: execution.workflowId,
      type: execution.type,
      statusName: execution.status.name,
      startTime: execution.startTime ?? null,
      parentExecutionId,
    });
  }

  // Time-window fallback: if a pipelineWorkflow lacks parentExecution,
  // attribute it to the most recent multiTicketWorkflow whose startTime
  // is at-or-before the child's startTime. multiTicketWorkflow spawns
  // children via executeChild during the wave loop, so a pipeline started
  // shortly after a parent is almost certainly its child. This is the
  // same heuristic /api/workflows/:id already uses for childWorkflowIds.
  const parents = raw
    .filter((r) => r.type === 'multiTicketWorkflow' && r.startTime !== null)
    .sort((a, b) => (a.startTime!.getTime() - b.startTime!.getTime()));
  function inferParent(child: RawExec): string | null {
    if (child.type !== 'pipelineWorkflow' || !child.startTime) return null;
    let best: RawExec | null = null;
    for (const p of parents) {
      if (p.startTime!.getTime() <= child.startTime.getTime()) best = p;
      else break;
    }
    return best?.workflowId ?? null;
  }

  for (const r of raw) {
    let state: string = r.statusName;
    let options: WorkflowOptionsCard | undefined;
    if (r.statusName === 'RUNNING') {
      const handle = client.workflow.getHandle(r.workflowId);
      try {
        state = await handle.query<string>('currentStateQuery');
      } catch {
        // multiTicketWorkflow doesn't define currentStateQuery; if it's
        // running it's awaiting plan approval.
        if (r.type === 'multiTicketWorkflow') state = 'PLAN_REVIEW';
      }
      // Best-effort options query — older workflows predate the handler.
      // Failure is silent; the list is the wrong place to surface a
      // per-workflow query error (the detail route already does that).
      try {
        options = await handle.query<WorkflowOptionsCard>('currentOptionsQuery');
      } catch {
        // Handler not registered on this run. Leave options undefined.
      }
    }

    const card: WorkflowCard = {
      workflowId: r.workflowId,
      state,
      ticketId: extractTicketId(r.workflowId),
      startTime: r.startTime?.toISOString() ?? null,
      workflowType: r.type,
      parentWorkflowId: r.parentExecutionId ?? inferParent(r),
      options,
    };

    response[classifyState(state)].push(card);
  }

  return c.json(response);
});

/**
 * Workflow detail — includes the wave plan when the workflow exposes a
 * currentPlanQuery handler (added in pipeline-worker on this PR). For
 * older workflows that predate the handler, plan is null and planFetchError
 * carries the reason.
 */
workflowsRoutes.get('/:id', async (c) => {
  const workflowId = c.req.param('id');
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  const desc = await handle.describe();
  const card: WorkflowCard = {
    workflowId,
    state: desc.status.name,
    ticketId: extractTicketId(workflowId),
    startTime: desc.startTime?.toISOString() ?? null,
    workflowType: desc.type,
  };

  // Try the app-level state query for running workflows.
  if (desc.status.name === 'RUNNING') {
    try {
      const queried = await handle.query<string>('currentStateQuery');
      card.state = queried;
    } catch {
      if (desc.type === 'multiTicketWorkflow') card.state = 'PLAN_REVIEW';
    }
  }

  // Workflow-launch options snapshot (e.g. skipProdDeploy). Available on
  // both running AND closed workflows — Temporal serves queries against
  // closed runs as long as they're inside the namespace's retention
  // window. Older workflows that predate currentOptionsQuery omit the
  // field entirely (caller renders nothing).
  let options: WorkflowOptionsCard | undefined;
  try {
    options = await handle.query<WorkflowOptionsCard>('currentOptionsQuery');
  } catch {
    // Handler not registered on this run.
  }
  card.options = options;

  // Fetch the wave plan via currentPlanQuery. Only multiTicketWorkflow has
  // this handler. Child pipelineWorkflows don't carry the wave plan — they
  // get a single ticket arg.
  let plan: WavePlan | null = null;
  let planFetchError: string | null = null;
  if (desc.type === 'multiTicketWorkflow') {
    try {
      plan = await handle.query<WavePlan | null>('currentPlanQuery');
    } catch (err) {
      planFetchError =
        err instanceof Error
          ? `currentPlanQuery unavailable: ${err.message}`
          : 'currentPlanQuery unavailable';
    }
  } else {
    planFetchError = `Plan only queryable on multiTicketWorkflow (this is ${desc.type})`;
  }

  // Best-effort: list child workflows of the same parent. Temporal's list API
  // doesn't directly support parent-of queries; we approximate by listing
  // pipeline-* workflows on the same task queue. Cheap; ~ms.
  const childWorkflowIds: string[] = [];
  if (desc.type === 'multiTicketWorkflow') {
    try {
      for await (const child of client.workflow.list({
        query: `TaskQueue="${TASK_QUEUE}" AND WorkflowType="pipelineWorkflow"`,
      })) {
        // Only include children that look like they came from this parent.
        // Heuristic: pipeline workflows started during the parent's lifetime.
        if (
          desc.startTime &&
          child.startTime &&
          child.startTime.getTime() >= desc.startTime.getTime()
        ) {
          childWorkflowIds.push(child.workflowId);
        }
        if (childWorkflowIds.length >= 50) break;
      }
    } catch {
      // Filter not supported on this Temporal SDK version — skip.
    }
  }

  // PR info — fetch via `currentPrQuery`, then ask GitHub for the live
  // PR state (open/merged/closed). The worker only stores the static
  // identifiers; PR state can change after the workflow ends (e.g. PR
  // closed manually after a CANCEL), so we don't cache it.
  let pr: PrInfoCard | null = null;
  if (desc.type === 'pipelineWorkflow') {
    try {
      const workerPr = await handle.query<WorkerPrInfo | null>('currentPrQuery');
      if (workerPr) {
        const ghState = await fetchGitHubPrState(workerPr.repoFullName, workerPr.prNumber);
        pr = {
          prNumber: workerPr.prNumber,
          prUrl: workerPr.prUrl,
          prTitle: workerPr.prTitle,
          repoFullName: workerPr.repoFullName,
          state: ghState,
        };
      }
    } catch {
      // Older workflows predate currentPrQuery — pr stays null.
    }
  }

  // For terminal failure states, extract the workflow's failure message via
  // handle.result(). result() throws WorkflowFailedError for failed runs;
  // its `cause` chain typically holds the ApplicationFailure thrown by the
  // workflow's outer catch. Best-effort: any extraction error falls back to
  // a generic label so the UI still renders something.
  let errorMessage: string | null = null;
  const TEMPORAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
    'FAILED',
    'CANCELLED',
    'TERMINATED',
    'TIMED_OUT',
  ]);
  if (TEMPORAL_FAILURE_STATUSES.has(desc.status.name)) {
    try {
      await handle.result();
      // result() resolved without throwing on a failure-status workflow —
      // shouldn't happen, but degrade gracefully.
      errorMessage = `Workflow status: ${desc.status.name}`;
    } catch (err) {
      errorMessage = formatWorkflowFailure(err, desc.status.name);
    }
  }

  const detail: WorkflowDetail = {
    ...card,
    plan,
    planFetchError,
    childWorkflowIds,
    pr,
    errorMessage,
  };
  return c.json(detail);
});

/**
 * Fetch the live PR state from GitHub. The PR endpoint returns
 * `state: "open" | "closed"` and a `merged: boolean`. Map to a
 * 3-value union so the UI can render distinct status pills.
 *
 * Best-effort: any error (token missing, 404, network) falls back to
 * 'open' so the UI still renders something useful. The PR URL is
 * always navigable regardless of the state field.
 */
async function fetchGitHubPrState(
  repoFullName: string,
  prNumber: number,
): Promise<'open' | 'closed' | 'merged'> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return 'open';
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'forge-console',
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!resp.ok) return 'open';
    const data = (await resp.json()) as { state?: string; merged?: boolean };
    if (data.merged === true) return 'merged';
    if (data.state === 'closed') return 'closed';
    return 'open';
  } catch {
    return 'open';
  }
}

/**
 * Disk-fallback for transcript: when a workflow is closed/terminated
 * (the live `transcriptSessionsQuery` handler can no longer respond),
 * scan the CC-session-JSONL cache directly to find the files that were
 * written during the workflow's lifetime.
 *
 * Worker writes sessions under `/home/ubuntu/.claude/projects/` keyed
 * by Claude Code's path-encoded cwd. Forge worktrees live at
 * `/tmp/forge-worktrees/<TICKET>/`, so CC encodes them as
 * `-tmp-forge-worktrees-<TICKET>` directories. We enumerate those
 * dirs and pick *.jsonl files whose mtime falls within the workflow's
 * [startTime, closeTime] window.
 *
 * Cross-pollination guard: if two pipelineWorkflows ran with
 * overlapping windows, both would match. Forge today serializes via
 * the session lock + per-worker task queues, so concurrent runs are
 * rare. The 60s slack on each side covers clock skew + dispatch
 * overhead; tighter window risks missing the first event of an
 * IMPLEMENT session, looser risks pulling in unrelated workflows.
 *
 * Returns paths sorted by mtime ascending (chronological).
 */
async function scanDiskForSessions(opts: {
  startTime: Date;
  closeTime: Date;
}): Promise<string[]> {
  const fs = await import('fs/promises');
  const path = await import('path');
  const PROJECTS_DIR = '/home/ubuntu/.claude/projects';

  let projectDirs: string[];
  try {
    const all = await fs.readdir(PROJECTS_DIR);
    projectDirs = all
      .filter((d) => d.startsWith('-tmp-forge-worktrees-'))
      .map((d) => path.join(PROJECTS_DIR, d));
  } catch {
    return [];
  }

  const SLACK_MS = 60_000;
  const startMs = opts.startTime.getTime() - SLACK_MS;
  const endMs = opts.closeTime.getTime() + SLACK_MS;

  const matches: { path: string; mtime: number }[] = [];
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const full = path.join(dir, entry);
      try {
        const st = await fs.stat(full);
        const m = st.mtime.getTime();
        if (m >= startMs && m <= endMs) {
          matches.push({ path: full, mtime: m });
        }
      } catch {
        continue;
      }
    }
  }

  matches.sort((a, b) => a.mtime - b.mtime);
  return matches.map((m) => m.path);
}

/**
 * Transcript export — concatenate the JSONL session files Claude Code
 * wrote for every CC subprocess this workflow spawned, in chronological
 * order. Two resolution paths:
 *
 *   - Live path (preferred): query `transcriptSessionsQuery` on the
 *     workflow handle; the worker has the canonical session-path list.
 *   - Disk fallback: when the workflow is closed/terminated and the
 *     live query fails, scan `/home/ubuntu/.claude/projects/-tmp-
 *     forge-worktrees-*` for *.jsonl files whose mtime falls within
 *     the workflow's [startTime, closeTime] window. Lets post-mortem
 *     analysis work on terminated workflows.
 *
 * Output is verbatim CC native JSONL — every line is the original JSON
 * object Claude Code wrote, no transformation. Missing files (rotated,
 * never written, permission-denied) are skipped with a warning header
 * comment line so the consumer can detect gaps without the stream
 * silently truncating.
 */
workflowsRoutes.get('/:id/transcript', async (c) => {
  const workflowId = c.req.param('id');
  const client = await getTemporalClient();
  const handle = client.workflow.getHandle(workflowId);

  let paths: string[] = [];
  let queryErr: Error | null = null;
  try {
    paths = await handle.query<string[]>('transcriptSessionsQuery');
  } catch (err) {
    queryErr = err instanceof Error ? err : new Error(String(err));
  }

  // Disk fallback when live query fails. Common cases:
  //   1. Workflow is terminated/closed → Temporal can't query it.
  //   2. Worker is down → query times out.
  //   3. Wrong workflow type (multiTicketWorkflow doesn't register
  //      transcriptSessionsQuery; use /transcripts-all instead).
  // For (1) and (2) we can recover via disk scan. For (3) the hint
  // tells the caller to use the parent route.
  let fallbackHeader: string | null = null;
  if (queryErr) {
    let desc;
    try {
      desc = await handle.describe();
    } catch (descErr) {
      // Workflow not findable at all — preserve the original 404 shape.
      return c.json(
        {
          ok: false,
          workflowId,
          error: `transcriptSessionsQuery unavailable: ${queryErr.message}`,
        },
        404,
      );
    }

    if (desc.type !== 'pipelineWorkflow') {
      return c.json(
        {
          ok: false,
          workflowId,
          error: `transcriptSessionsQuery unavailable: ${queryErr.message}`,
          hint:
            desc.type === 'multiTicketWorkflow'
              ? 'multiTicketWorkflow has no transcript of its own; use /transcripts-all to aggregate child transcripts.'
              : `Workflow type '${desc.type}' has no transcript handler.`,
        },
        404,
      );
    }

    const closeTime = desc.closeTime ?? new Date();
    paths = await scanDiskForSessions({
      startTime: desc.startTime,
      closeTime,
    });

    if (paths.length === 0) {
      return c.json(
        {
          ok: false,
          workflowId,
          error: `transcriptSessionsQuery unavailable: ${queryErr.message}`,
          hint:
            `Disk fallback found no JSONLs in window ${desc.startTime.toISOString()}..${closeTime.toISOString()}. ` +
            `Sessions may have been cleaned up, or this workflow never spawned a CC subprocess (e.g., failed before IMPLEMENT).`,
        },
        404,
      );
    }

    fallbackHeader =
      `# disk-fallback live-query-error="${queryErr.message.replace(/"/g, "'")}" ` +
      `startTime=${desc.startTime.toISOString()} closeTime=${closeTime.toISOString()} ` +
      `sessions=${paths.length}\n`;
  }

  // Best-effort options snapshot for the transcript header — useful for
  // post-mortems (e.g. "did this run skip prod?"). Live query, falls
  // back silently when unavailable.
  let optionsHeader = '';
  try {
    const opts = await handle.query<WorkflowOptionsCard>('currentOptionsQuery');
    if (opts && Object.keys(opts).length > 0) {
      optionsHeader = `# options ${JSON.stringify(opts)}\n`;
    }
  } catch {
    // Handler not registered on this run.
  }

  // Build a streaming NDJSON response. Pre-resolve presence so the
  // header summary is accurate; missing files become "# missing"
  // header comment lines (NDJSON readers tolerate a leading `#` when
  // the consumer is the official `forge transcript` CLI we ship,
  // which strips them — see core/src/commands/forge.ts).
  const fs = await import('fs/promises');
  const chunks: string[] = [];
  chunks.push(
    `# forge-transcript workflowId=${workflowId} sessions=${paths.length} ts=${new Date().toISOString()}\n`,
  );
  if (optionsHeader) chunks.push(optionsHeader);
  if (fallbackHeader) chunks.push(fallbackHeader);
  for (const p of paths) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      chunks.push(`# session=${p}\n`);
      chunks.push(content.endsWith('\n') ? content : content + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push(`# missing session=${p} reason=${msg}\n`);
    }
  }
  return new Response(chunks.join(''), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${workflowId}.transcript.jsonl"`,
    },
  });
});

/**
 * Aggregate transcript export for a multiTicketWorkflow parent —
 * concatenates every child's transcript in spawn order. Children are
 * resolved with the same time-window heuristic the detail route uses
 * (pipelineWorkflows on the same task queue whose startTime falls
 * during the parent's lifetime).
 *
 * Empty-case is graceful: a parent with no children (or all children
 * lacking transcripts) yields a header-only NDJSON response, never a
 * 4xx. The dashboard's "Export all transcripts" button is an inert
 * download in that case rather than a confusing error.
 */
workflowsRoutes.get('/:id/transcripts-all', async (c) => {
  const parentWorkflowId = c.req.param('id');
  const client = await getTemporalClient();
  const parentHandle = client.workflow.getHandle(parentWorkflowId);

  let parentDesc;
  try {
    parentDesc = await parentHandle.describe();
  } catch (err) {
    return c.json(
      { ok: false, workflowId: parentWorkflowId, error: err instanceof Error ? err.message : String(err) },
      404,
    );
  }

  // Reuse the detail-route heuristic verbatim — pipelineWorkflows on the
  // forge-pipeline queue that started during the parent's lifetime.
  const childIds: string[] = [];
  if (parentDesc.type === 'multiTicketWorkflow' && parentDesc.startTime) {
    try {
      for await (const child of client.workflow.list({
        query: `TaskQueue="${TASK_QUEUE}" AND WorkflowType="pipelineWorkflow"`,
      })) {
        if (
          child.startTime &&
          child.startTime.getTime() >= parentDesc.startTime.getTime()
        ) {
          childIds.push(child.workflowId);
        }
        if (childIds.length >= 50) break;
      }
    } catch {
      // SDK doesn't support this query filter — empty list, header-only.
    }
  }

  const fs = await import('fs/promises');
  const chunks: string[] = [];
  chunks.push(
    `# forge-transcripts-all parentWorkflowId=${parentWorkflowId} children=${childIds.length} ts=${new Date().toISOString()}\n`,
  );
  for (const childId of childIds) {
    chunks.push(`# child=${childId}\n`);
    let paths: string[] = [];
    try {
      paths = await client.workflow
        .getHandle(childId)
        .query<string[]>('transcriptSessionsQuery');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push(`# child-query-failed=${childId} reason=${msg}\n`);
      continue;
    }
    for (const p of paths) {
      try {
        const content = await fs.readFile(p, 'utf-8');
        chunks.push(`# session=${p}\n`);
        chunks.push(content.endsWith('\n') ? content : content + '\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chunks.push(`# missing session=${p} reason=${msg}\n`);
      }
    }
  }

  return new Response(chunks.join(''), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${parentWorkflowId}.transcripts-all.jsonl"`,
    },
  });
});

/**
 * Pull a useful one-liner out of a Temporal client failure. The SDK wraps
 * activity throws and workflow throws in a chain — peel down to the inner
 * cause where the original `throw new Error("...")` message lives.
 */
function formatWorkflowFailure(err: unknown, statusFallback: string): string {
  const seen = new Set<unknown>();
  let cur: any = err;
  let deepestMessage: string | null = null;
  // Walk up to 10 levels deep; chains beyond that are pathological.
  for (let i = 0; i < 10 && cur && !seen.has(cur); i++) {
    seen.add(cur);
    if (typeof cur.message === 'string' && cur.message.trim().length > 0) {
      deepestMessage = cur.message;
    }
    cur = cur.cause;
  }
  if (deepestMessage) return deepestMessage;
  if (err instanceof Error && err.message) return err.message;
  return `Workflow status: ${statusFallback}`;
}
