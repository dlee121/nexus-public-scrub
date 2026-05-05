import { join } from "path";

export interface NexusEntity {
  path: string;
  port: number;
  telegram?: boolean;
  emoji?: string;
  description?: string;
  autostart?: boolean;
  notify?: boolean;
  /**
   * Channel siloing — which channel notifyTaskResult posts to when this
   * entity is the recipient of a delegated task. "slack" = Forge-class
   * (engineer, advisor); "telegram" = content pipeline (writer);
   * "none" = silent (still injects into Orchestrator's session, but no user-facing
   * post and no relay). Default when unset: "slack".
   */
  notifyChannel?: "slack" | "telegram" | "none";
}

export interface NexusConfig {
  entities: Record<string, NexusEntity>;
  orchestrator: string;
  corePath: string;
}

/** Walk up from cwd to find nexus.json (max 6 levels). */
async function findNexusFile(): Promise<string | null> {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "nexus.json");
    if (await Bun.file(candidate).exists()) return candidate;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function loadNexus(): Promise<NexusConfig> {
  const path = await findNexusFile();
  if (!path) throw new Error("nexus.json not found. Run from within the Nexus workspace.");
  return Bun.file(path).json();
}

export function getEntity(nexus: NexusConfig, name: string): NexusEntity | null {
  return nexus.entities[name] ?? null;
}

/** Resolve the name of the entity whose path matches cwd. */
export function resolveCurrentEntity(nexus: NexusConfig): string | null {
  const cwd = process.cwd();
  for (const [name, entity] of Object.entries(nexus.entities)) {
    if (entity.path === cwd) return name;
  }
  return null;
}
