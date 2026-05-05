import { join } from "path";
import { loadNexus, getEntity, resolveCurrentEntity } from "../nexus";
import { writeTask, generateTaskId, type Task } from "../tasks";

/** Check if an entity daemon is running by reading its PID file. */
async function isEntityRunning(entityPath: string): Promise<boolean> {
  const pidFile = join(entityPath, ".claude/claudeclaw/daemon.pid");
  try {
    const pid = Number((await Bun.file(pidFile).text()).trim());
    if (!pid || !Number.isFinite(pid)) return false;
    process.kill(pid, 0); // throws if not running
    return true;
  } catch {
    return false;
  }
}

/** Spawn an entity daemon in the background. */
async function spawnEntity(entityPath: string, corePath: string): Promise<void> {
  const logFile = join(entityPath, ".claude/claudeclaw/logs/daemon.log");
  const proc = Bun.spawn(
    ["bun", "run", join(corePath, "src/index.ts"), "start"],
    {
      cwd: entityPath,
      stdin: "ignore",
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
    }
  );
  proc.unref();
  // Brief wait for daemon to write its PID file
  await Bun.sleep(1500);
  console.log(`  Spawned daemon for entity (PID ${proc.pid})`);
}

export async function delegate(args: string[]): Promise<void> {
  const entityName = args[0];
  const prompt = args.slice(1).join(" ").trim();

  if (!entityName || !prompt) {
    console.error("Usage: delegate <entity> <prompt>");
    process.exit(1);
  }

  const nexus = await loadNexus();
  const entity = getEntity(nexus, entityName);

  if (!entity) {
    const available = Object.keys(nexus.entities).join(", ");
    console.error(`Unknown entity: ${entityName}. Available: ${available}`);
    process.exit(1);
  }

  const fromEntity = resolveCurrentEntity(nexus) ?? nexus.orchestrator;

  const task: Task = {
    id: generateTaskId(),
    from: fromEntity,
    to: entityName,
    prompt,
    status: "pending",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
  };

  await writeTask(entity.path, task);
  console.log(`Task delegated: ${task.id}`);
  console.log(`  from: ${fromEntity} → to: ${entityName}`);

  // Ensure the target entity daemon is running
  const running = await isEntityRunning(entity.path);
  if (!running) {
    console.log(`  Entity '${entityName}' not running — spawning daemon...`);
    await spawnEntity(entity.path, nexus.corePath);
  } else {
    console.log(`  Entity '${entityName}' is running — task queued.`);
  }
}
