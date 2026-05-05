/**
 * Writer entity dispatcher — sends writing tasks to the Writer Nexus entity
 * and waits for completion. No direct Anthropic API key required.
 */

import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const CORE_PATH = process.env.NEXUS_CORE_PATH ?? "/Users/<user>/Nexus/core";
const WRITER_PATH = join(CORE_PATH, "entities/writer");
const INBOX = join(WRITER_PATH, ".claude/claudeclaw/tasks/inbox");
const DONE = join(WRITER_PATH, ".claude/claudeclaw/tasks/done");

const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 min per article

interface NexusTask {
  id: string;
  from: string;
  to: string;
  prompt: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
}

async function ensureDirs() {
  await mkdir(INBOX, { recursive: true });
  await mkdir(DONE, { recursive: true });
}

/** Write a task to Writer's inbox and wait for it to complete. */
export async function dispatchToWriter(prompt: string): Promise<string> {
  await ensureDirs();

  const task: NexusTask = {
    id: randomUUID(),
    from: "orchestrator",
    to: "writer",
    prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  };

  const tmpPath = join(INBOX, `${task.id}.tmp`);
  const destPath = join(INBOX, `${task.id}.json`);
  await writeFile(tmpPath, JSON.stringify(task, null, 2));
  await rename(tmpPath, destPath);

  // Task dispatched silently

  // Poll done/ directory for completion
  const deadline = Date.now() + TIMEOUT_MS;
  const donePath = join(DONE, `${task.id}.json`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    if (existsSync(donePath)) {
      const content = await readFile(donePath, "utf-8");
      const done = JSON.parse(content) as NexusTask;

      if (done.status === "completed" && done.result) {
        return done.result;
      }

      if (done.status === "failed") {
        throw new Error(`Writer task failed: ${done.error ?? "unknown error"}`);
      }
    }

    // Poll silently while the task remains in progress.
  }

  throw new Error(`Writer task timed out after ${TIMEOUT_MS / 1000}s: ${task.id}`);
}
