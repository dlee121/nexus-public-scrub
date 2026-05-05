import { join } from "path";
import { loadNexus, getEntity } from "../nexus";

async function isEntityRunning(entityPath: string): Promise<number | null> {
  const pidFile = join(entityPath, ".claude/claudeclaw/daemon.pid");
  try {
    const pid = Number((await Bun.file(pidFile).text()).trim());
    if (!pid || !Number.isFinite(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function spawn(args: string[]): Promise<void> {
  const entityName = args[0];

  if (!entityName) {
    console.error("Usage: spawn <entity>");
    process.exit(1);
  }

  const nexus = await loadNexus();
  const entity = getEntity(nexus, entityName);

  if (!entity) {
    const available = Object.keys(nexus.entities).join(", ");
    console.error(`Unknown entity: ${entityName}. Available: ${available}`);
    process.exit(1);
  }

  const existingPid = await isEntityRunning(entity.path);
  if (existingPid) {
    console.log(`Entity '${entityName}' is already running (PID ${existingPid}).`);
    return;
  }

  const logFile = join(entity.path, ".claude/claudeclaw/logs/daemon.log");
  const proc = Bun.spawn(
    ["bun", "run", join(nexus.corePath, "src/index.ts"), "start"],
    {
      cwd: entity.path,
      stdin: "ignore",
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
    }
  );
  proc.unref();

  await Bun.sleep(1500);
  const pid = await isEntityRunning(entity.path);
  if (pid) {
    console.log(`Entity '${entityName}' spawned (PID ${pid}).`);
  } else {
    console.log(`Entity '${entityName}' started (PID ${proc.pid}). Check logs at ${logFile}`);
  }
}
