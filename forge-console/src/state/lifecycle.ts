import { eventBuffer } from './event-buffer.ts';
import { broadcaster } from './sse-broadcast.ts';

/**
 * Mark a workflow as terminal — schedules its ring-buffer cleanup after the
 * grace period AND closes any active SSE broadcast channel for it.
 *
 * Call this from any code path that learns a workflow has ended (the
 * /internal/events/terminal route is the canonical caller). Never invoke
 * `eventBuffer.notifyTerminal` and `broadcaster.close` in isolation — they
 * are two halves of the same lifecycle event, and forgetting one (e.g.,
 * notifying the buffer but not closing the channel) leaves SSE clients
 * tailing a buffer that's about to be dropped.
 */
export function terminateWorkflow(workflowId: string): void {
  eventBuffer.notifyTerminal(workflowId);
  broadcaster.close(workflowId);
}
