import { Octokit } from '@octokit/rest';

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN not set');
    _octokit = new Octokit({ auth: token });
  }
  return _octokit;
}

export async function createPR(params: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<{ number: number; url: string }> {
  const octokit = getOctokit();
  const { data } = await octokit.rest.pulls.create({
    owner: params.owner,
    repo: params.repo,
    title: params.title,
    body: params.body,
    head: params.head,
    base: params.base,
  });
  return { number: data.number, url: data.html_url };
}

/**
 * Wait for all check runs on `headSha` to finish, then judge pass/fail by
 * conclusion. Fully dynamic — no list of expected check names. The contract:
 *
 *   - We poll `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`.
 *   - Zero check runs visible → CI hasn't started yet, keep polling.
 *   - Any check run still `queued`/`in_progress` → keep polling.
 *   - All `completed` → pass iff every conclusion is `success`, `skipped`,
 *     or `neutral`. Anything else (`failure`, `cancelled`, `timed_out`,
 *     `action_required`, `stale`, `null`) is a hard failure.
 *
 *     `neutral` admitted in 2026-05-02 because Cursor Bugbot returns it
 *     as its normal advisory completion ("no blocking issues found, but
 *     not certifying success either") — the original fail-closed
 *     interpretation blocked Task 4's PR #168 even though all real CI
 *     was green. `neutral` from any other source is similarly "advisory,
 *     not blocking" by GitHub's own definition.
 *
 * Rationale: the old contract took an explicit `requiredCheckNames` list,
 * sourced from nexus.json or branch protection. That list drifts every time
 * a workflow gets renamed (e.g., "Tests / integration" → "integration"
 * after a workflow refactor) and is unmaintainable as Forge spans more
 * repos. Trusting GitHub's own check-run set means ciWait adapts
 * automatically: if a repo adds a new required check, this picks it up
 * without a config change; if a check is removed, ditto.
 *
 * Caveat: this implicitly trusts that GitHub Actions has registered the
 * check runs we care about. A misconfigured PR with zero check runs will
 * spin until TIMEOUT_MS — that's a 6h max wait, not silent failure.
 */
export async function waitForRequiredChecks(params: {
  owner: string;
  repo: string;
  headSha: string;
}): Promise<'success' | 'failure'> {
  const octokit = getOctokit();
  const POLL_INTERVAL_MS = 30_000;
  const TIMEOUT_MS = 6 * 60 * 60 * 1000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: params.owner,
      repo: params.repo,
      ref: params.headSha,
      per_page: 100,
    });

    const runs = data.check_runs;

    if (runs.length === 0) {
      // No checks registered yet. CI may not have triggered — wait.
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    const stillRunning = runs.filter(r => r.status !== 'completed');
    if (stillRunning.length > 0) {
      console.log(
        `[ciWait] ${runs.length - stillRunning.length}/${runs.length} complete; ` +
        `pending: ${stillRunning.map(r => r.name).join(', ')}`
      );
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // All completed. `success`, `skipped`, and `neutral` count as pass.
    // See the function docstring for why `neutral` is admitted (Cursor
    // Bugbot and other advisory-only checks).
    const PASS = new Set<string | null>(['success', 'skipped', 'neutral']);
    const failed = runs.find(r => !PASS.has(r.conclusion ?? null));
    if (failed) {
      console.log(
        `[ciWait] Check failed: ${failed.name} concluded ${failed.conclusion}`
      );
      return 'failure';
    }

    console.log(`[ciWait] All ${runs.length} checks passed (success/skipped/neutral)`);
    return 'success';
  }
  throw new Error('CI_WAIT timed out after 6 hours');
}

export async function mergePR(params: {
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<string> {
  const octokit = getOctokit();
  const { data } = await octokit.rest.pulls.merge({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    merge_method: 'squash',
  });
  return data.sha ?? '';
}

/**
 * List the file paths changed by a commit. For squash-merged PRs (Forge's
 * default), this is the squashed diff — i.e. the same set of paths the
 * PR touched. Used by DEV_DEPLOY to decide whether the merge needs a
 * deploy at all (YAML/docs-only merges produce no Docker image, so
 * trying to deploy them just wastes time waiting for an ECR tag that
 * will never appear).
 */
export async function getCommitFiles(params: {
  owner: string;
  repo: string;
  sha: string;
}): Promise<string[]> {
  const octokit = getOctokit();
  const { data } = await octokit.rest.repos.getCommit({
    owner: params.owner,
    repo: params.repo,
    ref: params.sha,
  });
  return (data.files ?? []).map((f) => f.filename);
}

export interface ExternalComment {
  /** "issue-comment" (PR-level) or "review-comment" (line-level) or "review-body" or "check-run". */
  source: 'issue-comment' | 'review-comment' | 'review-body' | 'check-run';
  /** Author login (e.g. "cursor[bot]", "github-actions[bot]", or a human). */
  author: string;
  body: string;
  /** ISO timestamp of when GitHub recorded the comment. */
  createdAt: string;
  /** Direct URL on github.com so the operator can jump in. */
  htmlUrl?: string;
}

/**
 * Collect all comments / reviews / check-run conclusions on a PR that
 * came from outside Forge — i.e. anything that isn't Forge's own
 * self-generated `### Code review` issue comment.
 *
 * Sources:
 *   - Issue comments on the PR (Bugbot's "### Bugbot review" comment
 *     lives here, plus any human comments).
 *   - Review submissions (formal REQUEST_CHANGES / APPROVE bodies).
 *   - Review line comments (inline `pulls/{n}/comments`).
 *   - Check-run summaries with non-success conclusions (Bugbot also
 *     leaves a check run with a `summary` field containing its findings).
 *
 * Filter rules:
 *   - Drop Forge's own self-review (issue comment whose body starts with
 *     `## Code Review` or contains `### Code review`, by default authored
 *     as `[org]` per current behavior).
 *   - Drop comments older than `since` (defaults to: never, returns all).
 *   - Always include explicit blocking states (e.g. REQUEST_CHANGES) even
 *     if the body is empty.
 *
 * Used by Step 1's external-review wait: if this returns non-empty, the
 * address-review loop has feedback to fold in.
 */
export async function listExternalComments(params: {
  owner: string;
  repo: string;
  prNumber: number;
  /** Author logins to exclude (Forge's own bot identity). */
  excludeAuthors?: string[];
  /** Exclude bodies that match any of these regexes (e.g. /^## Code Review/). */
  excludeBodyPatterns?: RegExp[];
  /** Only include comments created at-or-after this ISO timestamp. */
  since?: string;
  /** Optional headSha — when provided, also fetch check-run summaries. */
  headSha?: string;
}): Promise<ExternalComment[]> {
  const octokit = getOctokit();
  const excludeAuthors = new Set(params.excludeAuthors ?? []);
  const excludeBodyPatterns = params.excludeBodyPatterns ?? [];
  const sinceMs = params.since ? Date.parse(params.since) : 0;

  const isExcluded = (author: string, body: string): boolean => {
    if (author && excludeAuthors.has(author)) return true;
    for (const re of excludeBodyPatterns) {
      if (re.test(body)) return true;
    }
    return false;
  };
  const isAfterSince = (createdAt: string): boolean => {
    if (!sinceMs) return true;
    return Date.parse(createdAt) >= sinceMs;
  };

  const out: ExternalComment[] = [];

  // 1. Issue comments (PR-level discussion)
  const { data: issueComments } = await octokit.rest.issues.listComments({
    owner: params.owner,
    repo: params.repo,
    issue_number: params.prNumber,
    per_page: 100,
  });
  for (const c of issueComments) {
    const author = c.user?.login ?? '';
    const body = c.body ?? '';
    if (!isAfterSince(c.created_at)) continue;
    if (isExcluded(author, body)) continue;
    out.push({
      source: 'issue-comment',
      author,
      body,
      createdAt: c.created_at,
      htmlUrl: c.html_url,
    });
  }

  // 2. Reviews (APPROVE / REQUEST_CHANGES / COMMENT)
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    per_page: 100,
  });
  for (const r of reviews) {
    const author = r.user?.login ?? '';
    const body = r.body ?? '';
    const submittedAt = r.submitted_at ?? new Date(0).toISOString();
    if (!isAfterSince(submittedAt)) continue;
    // REQUEST_CHANGES is intrinsically blocking even with empty body.
    if (r.state !== 'REQUEST_CHANGES' && isExcluded(author, body)) continue;
    out.push({
      source: 'review-body',
      author: author + (r.state ? ` [${r.state}]` : ''),
      body,
      createdAt: submittedAt,
      htmlUrl: r.html_url,
    });
  }

  // 3. Inline review line comments
  const { data: lineComments } = await octokit.rest.pulls.listReviewComments({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.prNumber,
    per_page: 100,
  });
  for (const c of lineComments) {
    const author = c.user?.login ?? '';
    const body = `${c.path}:${c.line ?? c.original_line ?? '?'} — ${c.body ?? ''}`;
    if (!isAfterSince(c.created_at)) continue;
    if (isExcluded(author, c.body ?? '')) continue;
    out.push({
      source: 'review-comment',
      author,
      body,
      createdAt: c.created_at,
      htmlUrl: c.html_url,
    });
  }

  // 4. Check-run summaries (only when the conclusion indicates there's
  // something to address). Bugbot's "✅ no issues found" lands here as
  // a `success` summary — surfacing it would drive the address-review
  // loop pointlessly. We only include check-runs whose conclusion is
  // explicitly actionable: failure, neutral (advisory-with-content),
  // action_required, timed_out, cancelled, stale. Pure success/skipped
  // produce no feedback even if their output text is non-empty.
  const ACTIONABLE_CHECK_CONCLUSIONS = new Set([
    'failure',
    'neutral',          // Bugbot's "advisory but worth a look" channel
    'action_required',
    'timed_out',
    'cancelled',
    'stale',
  ]);
  if (params.headSha) {
    try {
      const { data: checkRuns } = await octokit.rest.checks.listForRef({
        owner: params.owner,
        repo: params.repo,
        ref: params.headSha,
        per_page: 100,
      });
      for (const cr of checkRuns.check_runs ?? []) {
        if (cr.status !== 'completed') continue;
        if (!ACTIONABLE_CHECK_CONCLUSIONS.has(cr.conclusion ?? '')) continue;
        const summary = cr.output?.summary ?? '';
        const text = cr.output?.text ?? '';
        const combined = (summary + (text ? `\n\n${text}` : '')).trim();
        if (!combined) continue;
        out.push({
          source: 'check-run',
          author: cr.app?.slug ?? cr.name,
          body: `[${cr.name} → ${cr.conclusion}] ${combined}`,
          createdAt: cr.completed_at ?? new Date().toISOString(),
          htmlUrl: cr.html_url ?? undefined,
        });
      }
    } catch (err) {
      // Best-effort: don't fail the whole comment collection on a check
      // API hiccup. Caller still gets issue/review/line comments.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[listExternalComments] checks API failed (${msg}); continuing with comment sources only`);
    }
  }

  // Sort oldest → newest so the address-review prompt reads chronologically.
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}
