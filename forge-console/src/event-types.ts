/**
 * Wire format for events flowing from pipeline-worker activities into the
 * forge-console. Both the worker (POSTing to /internal/events) and the
 * console (broadcasting via SSE to browsers) speak this shape.
 *
 * A copy of this file lives at pipeline-worker/src/lib/event-types.ts —
 * keep them in sync. Single source of truth would require a shared package.
 */

export type ForgePhase = 'implement' | 'verify' | 'patrol' | 'review' | 'address-review';

export interface ForgeEvent {
  /** Workflow ID this event belongs to. Required. */
  workflowId: string;

  /** Optional ticket identifier (e.g. TKT-001). */
  ticketId?: string;

  /** Which CC phase generated this event. */
  phase?: ForgePhase;

  /** Optional Temporal activity ID for correlation. */
  activityId?: string;

  /** ISO 8601 timestamp of when the event was emitted by the worker. */
  ts: string;

  /**
   * Event "kind" — a coarse categorization. For stream-json events this is
   * the parsed `type` field ("assistant", "user", "system", etc.). For
   * non-stream-json events (errors, lifecycle markers), this is a custom
   * string like "stderr", "session_start", "session_end".
   */
  kind: string;

  /**
   * Free-form payload. For stream-json events, this is the parsed JSON
   * line verbatim. For others, an object with relevant fields. The console
   * does not validate this — it's opaque to the wire layer and rendered
   * by the UI based on `kind`.
   */
  payload: unknown;
}
