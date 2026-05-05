import { listExternalComments, type ExternalComment } from '../lib/github';
import { DEFAULT_REPO_NAME, getRepoConfig } from '../config';
import type { Ticket } from '../types';

/**
 * Pause after CI passes so external reviewers (Bugbot, humans, other
 * bots) have time to weigh in before Forge merges. Returns the set of
 * comments collected during the window.
 *
 * Why a window: PRs #170, #173, #175 were merged within seconds of
 * green CI. Bugbot was actually configured (its `Cursor Bugbot` check
 * appears alongside `unit` and `pre-commit`), but it posts its full
 * findings AFTER the check resolves — sometimes a minute or two later.
 * A blind 3-min sleep guarantees we don't race past it.
 *
 * Implementation: we sleep MIN_WINDOW_MS, then poll once for comments.
 * If new comments are still showing up at that point, we sleep another
 * 60s and re-poll. Capped at MAX_WINDOW_MS so the workflow can't get
 * pinned indefinitely by a chatty PR thread.
 */
export interface WaitForExternalReviewResult {
  /** All comments collected during the window. */
  comments: ExternalComment[];
  /** ms actually waited (informational; bounded by [MIN_WINDOW_MS, MAX_WINDOW_MS]). */
  windowMs: number;
}

const MIN_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
const MAX_WINDOW_MS = 8 * 60 * 1000; // 8 minutes
const QUIESCE_POLL_MS = 60 * 1000;   // 60s recheck cycle after MIN_WINDOW

/** Forge's own self-review markers — these get filtered out so the
 *  address-review prompt only sees external feedback. */
const FORGE_BODY_PATTERNS: RegExp[] = [
  /^## Code Review\b/m,
  /^### Code review\b/m,
];

export async function waitForExternalReviewActivity(params: {
  ticket: Ticket;
  prNumber: number;
  headSha: string;
  /**
   * Authors to filter out as "Forge itself" (the bot account that
   * Forge uses to author commits + post the self-review). Default
   * '[org]' matches the current worker config; pass an empty
   * array to disable author-based filtering.
   */
  forgeAuthors?: string[];
}): Promise<WaitForExternalReviewResult> {
  const { ticket, prNumber, headSha } = params;
  const repoConfig = getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME);
  const forgeAuthors = params.forgeAuthors ?? ['[org]'];

  const start = Date.now();
  console.log(
    `[waitForExternalReview] PR #${prNumber} sha=${headSha.slice(0, 12)} — sleeping ${MIN_WINDOW_MS / 1000}s minimum window...`
  );
  await new Promise((r) => setTimeout(r, MIN_WINDOW_MS));

  // Read whatever's there now.
  let comments = await listExternalComments({
    owner: repoConfig.repoOwner,
    repo: repoConfig.repoName,
    prNumber,
    excludeAuthors: forgeAuthors,
    excludeBodyPatterns: FORGE_BODY_PATTERNS,
    headSha,
  });

  // Quiesce loop: if a new comment landed in the last 60s of the window,
  // give it another minute in case more are en route. Cap total wait
  // at MAX_WINDOW_MS so the workflow doesn't stall on a chatty thread.
  while (Date.now() - start < MAX_WINDOW_MS) {
    const recent = mostRecentTimestamp(comments);
    const recentMs = recent ? Date.parse(recent) : 0;
    const tailWindowMs = QUIESCE_POLL_MS;
    if (recent && Date.now() - recentMs < tailWindowMs) {
      console.log(
        `[waitForExternalReview] last comment was ${Math.round((Date.now() - recentMs) / 1000)}s ago; quiescing for another ${tailWindowMs / 1000}s`
      );
      await new Promise((r) => setTimeout(r, tailWindowMs));
      comments = await listExternalComments({
        owner: repoConfig.repoOwner,
        repo: repoConfig.repoName,
        prNumber,
        excludeAuthors: forgeAuthors,
        excludeBodyPatterns: FORGE_BODY_PATTERNS,
        headSha,
      });
      continue;
    }
    break;
  }

  const windowMs = Date.now() - start;
  console.log(
    `[waitForExternalReview] PR #${prNumber} window=${windowMs}ms collected ${comments.length} external comment(s); ` +
    `authors=${[...new Set(comments.map((c) => c.author))].join(', ') || '(none)'}`
  );
  return { comments, windowMs };
}

function mostRecentTimestamp(comments: ExternalComment[]): string | null {
  if (comments.length === 0) return null;
  // listExternalComments returns sorted oldest-first.
  return comments[comments.length - 1].createdAt;
}
