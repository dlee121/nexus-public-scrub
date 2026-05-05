import type { ForgeEvent } from '../event-types.ts';

/**
 * Per-workflow pub/sub for SSE clients.
 *
 * Each browser-side EventSource subscribes via Hono's c.streamSSE. The
 * handler calls subscribe(wfId) to get an async iterator that yields every
 * event published for that workflow until the subscriber closes.
 *
 * Implementation: per workflow, a Set of "pending resolvers" — promises
 * blocked on the next event. publish() resolves all of them and clears
 * the set. On unsubscribe, remaining resolvers are rejected with a
 * monitor so the iterator's for-await sees the close.
 *
 * No backpressure: a slow subscriber can't slow the publisher, but if it
 * stalls long enough the connection times out and the subscription is
 * cleaned up. SSE clients reconnect automatically, replaying from the
 * ring buffer.
 */

interface QueuedResolver {
  resolve: (value: ForgeEvent | typeof CLOSED) => void;
}

const CLOSED = Symbol('subscription-closed');

class WorkflowChannel {
  private readonly resolvers = new Set<QueuedResolver>();
  private readonly pendingEvents: ForgeEvent[] = [];
  private closed = false;

  publish(event: ForgeEvent): void {
    if (this.closed) return;
    if (this.resolvers.size > 0) {
      for (const r of this.resolvers) r.resolve(event);
      this.resolvers.clear();
    } else {
      // No active subscribers — drop. Replays come from the ring buffer
      // when a fresh subscriber connects, not from this in-flight queue.
    }
  }

  async *subscribe(): AsyncIterableIterator<ForgeEvent> {
    while (!this.closed) {
      // Track our own resolver in a try/finally so a forced .return() on the
      // generator (called from the SSE handler when a client disconnects)
      // unregisters us from the channel's resolvers Set. Without this, an
      // abandoned subscription would leave a dangling resolver until the
      // next publish flushed it — slow leak under chatty disconnect cycles.
      let myResolver: QueuedResolver | null = null;
      try {
        const next = await new Promise<ForgeEvent | typeof CLOSED>((resolve) => {
          myResolver = { resolve };
          this.resolvers.add(myResolver);
        });
        if (next === CLOSED) return;
        yield next;
      } finally {
        if (myResolver) this.resolvers.delete(myResolver);
      }
    }
  }

  close(): void {
    this.closed = true;
    for (const r of this.resolvers) r.resolve(CLOSED);
    this.resolvers.clear();
  }
}

/**
 * Top-level broadcaster — keyed per workflow. Channels are created lazily on
 * first subscribe or publish.
 */
class SseBroadcaster {
  private readonly channels = new Map<string, WorkflowChannel>();

  publish(event: ForgeEvent): void {
    const ch = this.channels.get(event.workflowId);
    if (ch) ch.publish(event);
  }

  subscribe(workflowId: string): AsyncIterableIterator<ForgeEvent> {
    let ch = this.channels.get(workflowId);
    if (!ch) {
      ch = new WorkflowChannel();
      this.channels.set(workflowId, ch);
    }
    return ch.subscribe();
  }

  /**
   * Close a channel — used when notifyTerminal triggers cleanup. All
   * subscribers' iterators end. Browsers reconnect via EventSource and
   * fall through to the ring-buffer replay (which itself decays after the
   * grace period).
   */
  close(workflowId: string): void {
    const ch = this.channels.get(workflowId);
    if (ch) {
      ch.close();
      this.channels.delete(workflowId);
    }
  }

  stats() {
    return { channels: this.channels.size };
  }
}

export const broadcaster = new SseBroadcaster();
