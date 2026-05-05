import type { ForgeEvent } from '../event-types.ts';

// Tunables — exposed as named exports so smoke tests / future config can
// override. The defaults are sized for ~50MB total memory ceiling assuming
// ~1KB/event: 50 active workflows × 500 events × 2x slack.
export const EVENTS_PER_WORKFLOW = 500;
export const MAX_ACTIVE_WORKFLOWS = 50;
export const TERMINAL_GRACE_MS = 5 * 60 * 1000; // 5 minutes after terminal

interface BufferEntry {
  events: ForgeEvent[];   // ring; oldest at index 0
  lastWriteAt: number;    // ms — for LRU eviction
  evictAt: number | null; // ms — set when notifyTerminal called; null otherwise
}

/**
 * Per-workflow ring buffer with two eviction triggers:
 *
 *   1. Per-buffer overflow: when a workflow accumulates more than
 *      EVENTS_PER_WORKFLOW events, the oldest are dropped on each push.
 *
 *   2. Cross-workflow LRU: when MAX_ACTIVE_WORKFLOWS is exceeded, the
 *      least-recently-written buffer is dropped wholesale on next push.
 *
 *   3. Terminal grace: when notifyTerminal(wfId) is called, the buffer is
 *      scheduled for cleanup TERMINAL_GRACE_MS later. Operators retain a
 *      window to scroll back through completed runs.
 *
 * All operations are synchronous; state is in-memory only. Console restarts
 * lose all events (durable record lives in pipeline-worker/logs/ and
 * Temporal Cloud history).
 */
export class EventBuffer {
  private readonly buffers = new Map<string, BufferEntry>();

  push(event: ForgeEvent): void {
    const wfId = event.workflowId;
    const now = Date.now();

    let entry = this.buffers.get(wfId);
    if (!entry) {
      this.evictLruIfNeeded(now);
      entry = { events: [], lastWriteAt: now, evictAt: null };
      this.buffers.set(wfId, entry);
    }

    entry.events.push(event);
    if (entry.events.length > EVENTS_PER_WORKFLOW) {
      // Slice from the tail; keep the most recent N. Array.shift in a loop
      // would be O(n²) over many overflows.
      entry.events = entry.events.slice(-EVENTS_PER_WORKFLOW);
    }
    entry.lastWriteAt = now;
  }

  get(wfId: string): readonly ForgeEvent[] {
    return this.buffers.get(wfId)?.events ?? [];
  }

  /**
   * Mark a workflow as terminal — its buffer will be dropped after a grace
   * period. If called multiple times for the same workflow, the grace period
   * is reset (so an operator can keep a recently-completed buffer warm by
   * reconnecting). Idempotent for unknown workflowIds.
   */
  notifyTerminal(wfId: string): void {
    const entry = this.buffers.get(wfId);
    if (!entry) return;
    entry.evictAt = Date.now() + TERMINAL_GRACE_MS;
  }

  /**
   * Periodic cleanup tick — drops any buffers whose evictAt has passed.
   * Wire this to a setInterval at server startup.
   */
  sweep(): void {
    const now = Date.now();
    for (const [wfId, entry] of this.buffers) {
      if (entry.evictAt !== null && entry.evictAt <= now) {
        this.buffers.delete(wfId);
      }
    }
  }

  /** Diagnostic — used by /healthz to surface buffer state. */
  stats() {
    let totalEvents = 0;
    for (const entry of this.buffers.values()) totalEvents += entry.events.length;
    return {
      activeWorkflows: this.buffers.size,
      totalEvents,
      cap: { perWorkflow: EVENTS_PER_WORKFLOW, maxActive: MAX_ACTIVE_WORKFLOWS },
    };
  }

  private evictLruIfNeeded(now: number): void {
    if (this.buffers.size < MAX_ACTIVE_WORKFLOWS) return;

    // Find the least-recently-written buffer that is NOT in terminal grace.
    // Terminal-grace buffers have evictAt set; we'd rather drop a live but
    // chatty stale buffer than yank one the operator just paused on.
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [wfId, entry] of this.buffers) {
      if (entry.evictAt !== null) continue; // skip — has its own deadline
      if (entry.lastWriteAt < oldestAt) {
        oldestAt = entry.lastWriteAt;
        oldestId = wfId;
      }
    }

    // If everything is in terminal grace, drop the one with the soonest
    // evictAt anyway — we need the slot.
    if (oldestId === null) {
      let soonestAt = Infinity;
      for (const [wfId, entry] of this.buffers) {
        if (entry.evictAt !== null && entry.evictAt < soonestAt) {
          soonestAt = entry.evictAt;
          oldestId = wfId;
        }
      }
    }

    if (oldestId !== null) {
      this.buffers.delete(oldestId);
    }
  }
}

export const eventBuffer = new EventBuffer();
