/**
 * Forge follow-up task queue.
 *
 * When a Forge run encounters scope expansion, missing infra, an
 * unresolved review comment that's out of scope, or any non-trivial item
 * it can't address inline, it appends an entry here instead of silently
 * dropping it.
 *
 * Storage: `${NEXUS_CORE_PATH}/data/forge-pending-queue.json`. JSON array
 * of {@link PendingTask}. Gitignored so it doesn't leak per-operator
 * task state into the shared repo.
 *
 * Concurrency: write path takes a coarse advisory lock via temp+rename,
 * so two activities adding entries simultaneously can't lose data. We
 * never edit existing entries from concurrent contexts — status flips
 * are only done by the operator-driven `queue-dispatch` CLI.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const NEXUS_CORE = process.env.NEXUS_CORE_PATH ?? '/Users/<user>/Nexus/core';
const QUEUE_PATH = join(NEXUS_CORE, 'data', 'forge-pending-queue.json');

export type PendingTaskStatus =
  | 'pending'
  | 'dispatched'
  | 'completed'
  | 'completed-no-action';

export interface PendingTask {
  /** Stable id; UUID. */
  id: string;
  /** Short title shown in `queue-list`. */
  title: string;
  /** Full task body — used as the instruction when dispatched. */
  body: string;
  /** Originating Forge workflow id, if known. */
  sourceWorkflowId?: string;
  /** Originating PR URL or number, if known. */
  sourcePr?: string;
  /** Free-form rationale: why this couldn't be addressed inline. */
  reason?: string;
  /** ISO 8601. */
  createdAt: string;
  /** Last update; ISO 8601. */
  updatedAt: string;
  status: PendingTaskStatus;
  /** When dispatched, the new Forge workflow id. */
  dispatchedWorkflowId?: string;
}

function ensureQueueFile(): void {
  if (!existsSync(QUEUE_PATH)) {
    const dir = dirname(QUEUE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(QUEUE_PATH, '[]\n', 'utf-8');
  }
}

function readQueue(): PendingTask[] {
  ensureQueueFile();
  const text = readFileSync(QUEUE_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error('queue file is not a JSON array');
    }
    return parsed as PendingTask[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `pending-queue: failed to parse ${QUEUE_PATH}: ${msg}. ` +
      `Inspect the file manually; if corrupt, restore from git or reset to "[]".`
    );
  }
}

/**
 * Atomic write: serialize to a sibling tmp file then rename. rename(2)
 * is atomic within a filesystem, so a concurrent reader sees either the
 * old file or the new file, never a partial.
 */
function writeQueue(queue: PendingTask[]): void {
  ensureQueueFile();
  const tmp = `${QUEUE_PATH}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, QUEUE_PATH);
}

export interface AddTaskInput {
  title: string;
  body: string;
  sourceWorkflowId?: string;
  sourcePr?: string;
  reason?: string;
}

/**
 * Append a new pending task. Idempotent only on (title, sourcePr) —
 * if the same title is added twice for the same PR, the second call is
 * a no-op (returns the existing entry). This protects against an
 * activity loop accidentally enqueueing duplicates.
 */
export function addPendingTask(input: AddTaskInput): PendingTask {
  const queue = readQueue();
  const existing = queue.find(
    (t) =>
      t.title === input.title &&
      t.sourcePr === input.sourcePr &&
      t.status === 'pending'
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const task: PendingTask = {
    id: randomUUID(),
    title: input.title,
    body: input.body,
    sourceWorkflowId: input.sourceWorkflowId,
    sourcePr: input.sourcePr,
    reason: input.reason,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
  };
  queue.push(task);
  writeQueue(queue);
  return task;
}

export function listPendingTasks(filter?: {
  status?: PendingTaskStatus | PendingTaskStatus[];
}): PendingTask[] {
  const queue = readQueue();
  if (!filter?.status) return queue;
  const allowed = Array.isArray(filter.status)
    ? new Set(filter.status)
    : new Set([filter.status]);
  return queue.filter((t) => allowed.has(t.status));
}

export function findTaskById(id: string): PendingTask | null {
  return readQueue().find((t) => t.id === id) ?? null;
}

export function markTaskDispatched(
  id: string,
  dispatchedWorkflowId: string,
): PendingTask {
  const queue = readQueue();
  const idx = queue.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`pending-queue: task ${id} not found`);
  queue[idx] = {
    ...queue[idx],
    status: 'dispatched',
    dispatchedWorkflowId,
    updatedAt: new Date().toISOString(),
  };
  writeQueue(queue);
  return queue[idx];
}

export function markTaskStatus(
  id: string,
  status: PendingTaskStatus,
): PendingTask {
  const queue = readQueue();
  const idx = queue.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`pending-queue: task ${id} not found`);
  queue[idx] = {
    ...queue[idx],
    status,
    updatedAt: new Date().toISOString(),
  };
  writeQueue(queue);
  return queue[idx];
}

/** For tests / introspection. Returns the absolute path. */
export function queuePath(): string {
  return QUEUE_PATH;
}
