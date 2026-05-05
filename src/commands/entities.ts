import { join } from "path";
import { loadNexus } from "../nexus";
import { readPendingTasks } from "../tasks";

async function getEntityStatus(entityPath: string): Promise<{ running: boolean; pid: number | null; pendingTasks: number }> {
  const pidFile = join(entityPath, ".claude/claudeclaw/daemon.pid");
  let running = false;
  let pid: number | null = null;

  try {
    const raw = Number((await Bun.file(pidFile).text()).trim());
    if (raw && Number.isFinite(raw)) {
      process.kill(raw, 0);
      running = true;
      pid = raw;
    }
  } catch {}

  const pendingTasks = (await readPendingTasks(entityPath)).length;
  return { running, pid, pendingTasks };
}

export async function entities(_args: string[]): Promise<void> {
  const nexus = await loadNexus();

  console.log("\nNexus Entities\n" + "─".repeat(50));

  for (const [name, entity] of Object.entries(nexus.entities)) {
    const isOrchestrator = name === nexus.orchestrator;
    const { running, pid, pendingTasks } = await getEntityStatus(entity.path);

    const emoji = entity.emoji ?? "🤖";
    const statusSymbol = running ? "●" : "○";
    const statusLabel = running ? `running (PID ${pid})` : "stopped";
    const orchestratorLabel = isOrchestrator ? " [orchestrator]" : "";

    console.log(`\n${emoji}  ${name}${orchestratorLabel}`);
    console.log(`   ${statusSymbol} ${statusLabel}`);
    if (entity.description) console.log(`   ${entity.description}`);
    console.log(`   path: ${entity.path}`);
    if (pendingTasks > 0) console.log(`   pending tasks: ${pendingTasks}`);
  }

  console.log("\n" + "─".repeat(50));
}
