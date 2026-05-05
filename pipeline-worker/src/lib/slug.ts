/**
 * Slug helper for descriptive workflow IDs.
 *
 * Used by:
 *   - cli/trigger.ts            forge-<slug>-<ts>      (multi-ticket parent)
 *   - workflows/MultiTicketWorkflow.ts
 *                               pipeline-<slug>-<ts>-<idx>
 *                                                        (per-ticket child)
 *
 * Constraints:
 *   - Pure function with no I/O; safe to call inside a Temporal workflow.
 *   - Output is lowercase, hyphen-separated, alphanumeric only.
 *   - Bounded length (default 40 chars). Truncates at the last hyphen
 *     past 60% of the limit when possible — gives a readable cut-off
 *     rather than a mid-word slice.
 *   - Returns 'task' for empty / whitespace-only input so callers can
 *     always concatenate without a guard.
 */

const DEFAULT_MAX_LEN = 40;

export function slugify(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  const normalized = input
    .toLowerCase()
    .normalize('NFKD')              // strip accents
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')    // any non-alphanumeric run → hyphen
    .replace(/^-+|-+$/g, '');       // trim leading/trailing hyphens

  if (!normalized) return 'task';
  if (normalized.length <= maxLen) return normalized;

  // Word-aware truncation: prefer the last hyphen that still leaves us
  // with at least 60% of the budget filled. Below that, hard-cut.
  const hardCut = normalized.slice(0, maxLen);
  const lastDash = hardCut.lastIndexOf('-');
  if (lastDash >= maxLen * 0.6) return hardCut.slice(0, lastDash);
  return hardCut.replace(/-+$/, '');
}
