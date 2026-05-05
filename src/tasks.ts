import { mkdir, readdir, readFile, rename, unlink } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: string;
  from: string;
  to: string;
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
}

function inboxDir(entityDir: string) {
  return join(entityDir, ".claude/claudeclaw/tasks/inbox");
}

function doneDir(entityDir: string) {
  return join(entityDir, ".claude/claudeclaw/tasks/done");
}

async function ensureTaskDirs(entityDir: string): Promise<void> {
  await mkdir(inboxDir(entityDir), { recursive: true });
  await mkdir(doneDir(entityDir), { recursive: true });
}

/** Atomically write a task to an entity's inbox. */
export async function writeTask(entityDir: string, task: Task): Promise<void> {
  await ensureTaskDirs(entityDir);
  const tmp = join(inboxDir(entityDir), `${task.id}.tmp`);
  const dest = join(inboxDir(entityDir), `${task.id}.json`);
  await Bun.write(tmp, JSON.stringify(task, null, 2));
  await rename(tmp, dest);
}

/** Read all pending tasks from an entity's inbox. */
export async function readPendingTasks(entityDir: string): Promise<Task[]> {
  const dir = inboxDir(entityDir);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const tasks: Task[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const content = await readFile(join(dir, f), "utf-8");
      const task = JSON.parse(content) as Task;
      if (task.status === "pending") tasks.push(task);
    } catch {}
  }
  return tasks;
}

/** Mark a task as in_progress in-place. */
export async function markInProgress(entityDir: string, task: Task): Promise<Task> {
  const updated: Task = { ...task, status: "in_progress", startedAt: new Date().toISOString() };
  await Bun.write(join(inboxDir(entityDir), `${task.id}.json`), JSON.stringify(updated, null, 2));
  return updated;
}

/** Move task to done/ with status=completed. */
export async function completeTask(entityDir: string, task: Task, result: string): Promise<Task> {
  const updated: Task = { ...task, status: "completed", completedAt: new Date().toISOString(), result };
  await Bun.write(join(doneDir(entityDir), `${task.id}.json`), JSON.stringify(updated, null, 2));
  try { await unlink(join(inboxDir(entityDir), `${task.id}.json`)); } catch {}
  return updated;
}

/** Move task to done/ with status=failed. */
export async function failTask(entityDir: string, task: Task, error: string): Promise<Task> {
  const updated: Task = { ...task, status: "failed", completedAt: new Date().toISOString(), error };
  await Bun.write(join(doneDir(entityDir), `${task.id}.json`), JSON.stringify(updated, null, 2));
  try { await unlink(join(inboxDir(entityDir), `${task.id}.json`)); } catch {}
  return updated;
}

export function generateTaskId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `task_${Date.now()}_${rand}`;
}
