import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";

const HEARTBEAT_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(HEARTBEAT_DIR, "settings.json");
const JOBS_DIR = join(HEARTBEAT_DIR, "jobs");
const LOGS_DIR = join(HEARTBEAT_DIR, "logs");

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan", "design", "architect", "strategy", "approach",
          "research", "investigate", "analyze", "explore", "understand",
          "think", "consider", "evaluate", "assess", "review",
          "system design", "trade-off", "decision", "choose", "compare",
          "brainstorm", "ideate", "concept", "proposal",
        ],
        phrases: [
          "how to implement", "how should i", "what's the best way to",
          "should i", "which approach", "help me decide", "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement", "code", "write", "create", "build", "add",
          "fix", "debug", "refactor", "update", "modify", "change",
          "deploy", "run", "execute", "install", "configure",
          "test", "commit", "push", "merge", "release",
          "generate", "scaffold", "setup", "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  heartbeat: {
    enabled: false,
    interval: 15,
    prompt: "",
    excludeWindows: [],
    forwardToTelegram: true,
  },
  telegram: { token: "", allowedUserIds: [] },
  slack: { token: "", channelId: "", allowedUserIds: [] },
  discord: { token: "", allowedUserIds: [], listenChannels: [] },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
  promptsDir: "",
  bootstrapPrompt: "",
  sessionResetThreshold: 1500,
};

export interface HeartbeatExcludeWindow {
  days?: number[];
  start: string;
  end: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval: number;
  prompt: string;
  excludeWindows: HeartbeatExcludeWindow[];
  forwardToTelegram: boolean;
}

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
}

export interface SlackConfig {
  token: string;
  channelId: string;
  allowedUserIds: string[];
}

export interface DiscordConfig {
  token: string;
  allowedUserIds: string[]; // Discord snowflake IDs exceed Number.MAX_SAFE_INTEGER
  listenChannels: string[]; // Channel IDs where bot responds to all messages (no mention needed)
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  heartbeat: HeartbeatConfig;
  telegram: TelegramConfig;
  slack: SlackConfig;
  discord: DiscordConfig;
  security: SecurityConfig;
  web: WebConfig;
  stt: SttConfig;
  /** Directory containing IDENTITY.md, USER.md, SOUL.md, and heartbeat/HEARTBEAT.md.
   *  Relative paths resolve from the project root (cwd). When empty, falls back to
   *  the prompts/ directory inside the Nexus installation. */
  promptsDir: string;
  /** Custom first message sent when bootstrapping a new session. */
  bootstrapPrompt: string;
  /** Turn count at which the active session is archived and a fresh one
   *  is started on the next invocation. Even with proactive compact, very
   *  long sessions accumulate context degradation; this caps total session
   *  lifetime so the active thread stays coherent. Default 1500. Set to 0
   *  to disable. */
  sessionResetThreshold: number;
}

export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SttConfig {
  /** Base URL of an OpenAI-compatible STT API, e.g. "http://127.0.0.1:8000".
   *  When set, the daemon routes voice transcription through this API instead
   *  of the bundled whisper.cpp binary. */
  baseUrl: string;
  /** Model name passed to the API (default: "Systran/faster-whisper-large-v3") */
  model: string;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(HEARTBEAT_DIR, { recursive: true });
  await mkdir(JOBS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseAgenticMode(raw: any): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k: unknown) => typeof k === "string").map((k: string) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(raw.phrases)
    ? raw.phrases.filter((p: unknown) => typeof p === "string").map((p: string) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: any): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;

  const enabled = raw.enabled ?? false;

  // Backward compat: old planningModel/implementationModel format
  if (!Array.isArray(raw.modes) && ("planningModel" in raw || "implementationModel" in raw)) {
    const planningModel = typeof raw.planningModel === "string" ? raw.planningModel.trim() : "opus";
    const implModel = typeof raw.implementationModel === "string" ? raw.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  // New modes format
  const modes: AgenticMode[] = [];
  if (Array.isArray(raw.modes)) {
    for (const m of raw.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

/**
 * Resolve a token-like field from settings.json with env-var fallback.
 *
 * settings.json passes through pre-commit sanitization that periodically
 * rewrites live secrets to `***REMOVED***`. We can't put the real token
 * back because the next sanitizer run will redact it again. Instead,
 * when the file value is missing / redacted / an unresolved `${VAR}`
 * placeholder, fall back to the corresponding environment variable —
 * scripts/launch_nexus.sh sources .mcp-secrets.env before exec'ing the
 * daemon, so SLACK_BOT_TOKEN (etc.) are present in process.env.
 *
 * Treated as "no live value, please use env":
 *   - empty string after trim
 *   - the literal string `***REMOVED***`
 *   - any string starting with `${` (shell-style placeholder that wasn't
 *     expanded — e.g., a user copied .mcp-secrets.env.example into
 *     settings.json verbatim)
 */
function resolveSecret(rawValue: unknown, envVarName: string): string {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (raw === "" || raw === "***REMOVED***" || raw.startsWith("${")) {
    return process.env[envVarName] ?? "";
  }
  return raw;
}

function parseSettings(raw: Record<string, any>, discordUserIds?: string[]): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    heartbeat: {
      enabled: raw.heartbeat?.enabled ?? false,
      interval: raw.heartbeat?.interval ?? 15,
      prompt: raw.heartbeat?.prompt ?? "",
      excludeWindows: parseExcludeWindows(raw.heartbeat?.excludeWindows),
      forwardToTelegram: raw.heartbeat?.forwardToTelegram ?? false,
    },
    telegram: {
      token: resolveSecret(raw.telegram?.token, "TELEGRAM_BOT_TOKEN"),
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
    },
    slack: {
      token: resolveSecret(raw.slack?.token, "SLACK_BOT_TOKEN"),
      channelId: raw.slack?.channelId ?? "",
      allowedUserIds: raw.slack?.allowedUserIds ?? [],
    },
    discord: {
      token: typeof raw.discord?.token === "string" ? raw.discord.token.trim() : "",
      allowedUserIds: discordUserIds && discordUserIds.length > 0
        ? discordUserIds
        : Array.isArray(raw.discord?.allowedUserIds)
          ? raw.discord.allowedUserIds.map(String)
          : [],
      listenChannels: Array.isArray(raw.discord?.listenChannels)
        ? raw.discord.listenChannels.map(String)
        : [],
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
    },
    promptsDir: typeof raw.promptsDir === "string" ? raw.promptsDir.trim() : "",
    bootstrapPrompt: typeof raw.bootstrapPrompt === "string" ? raw.bootstrapPrompt.trim() : "",
    sessionResetThreshold:
      typeof raw.sessionResetThreshold === "number" &&
      Number.isFinite(raw.sessionResetThreshold) &&
      raw.sessionResetThreshold >= 0
        ? Math.floor(raw.sessionResetThreshold)
        : 1500,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseExcludeWindows(value: unknown): HeartbeatExcludeWindow[] {
  if (!Array.isArray(value)) return [];
  const out: HeartbeatExcludeWindow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const start = typeof (entry as any).start === "string" ? (entry as any).start.trim() : "";
    const end = typeof (entry as any).end === "string" ? (entry as any).end.trim() : "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) continue;

    const rawDays = Array.isArray((entry as any).days) ? (entry as any).days : [];
    const parsedDays = rawDays
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    const uniqueDays = Array.from(new Set<number>(parsedDays)).sort((a: number, b: number) => a - b);

    out.push({
      start,
      end,
      days: uniqueDays.length > 0 ? uniqueDays : [...ALL_DAYS],
    });
  }
  return out;
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

/**
 * Extract discord.allowedUserIds as raw strings from the JSON text.
 * JSON.parse destroys precision on large numeric snowflakes (>2^53),
 * so we regex them out of the raw text first.
 */
function extractDiscordUserIds(rawText: string): string[] {
  // Match the "discord" object's "allowedUserIds" array values
  const discordBlock = rawText.match(/"discord"\s*:\s*\{[\s\S]*?\}/);
  if (!discordBlock) return [];
  const arrayMatch = discordBlock[0].match(/"allowedUserIds"\s*:\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const items: string[] = [];
  // Match both quoted strings and bare numbers
  for (const m of arrayMatch[1].matchAll(/("(\d+)"|(\d+))/g)) {
    items.push(m[2] ?? m[3]);
  }
  return items;
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

/** Re-read settings from disk, bypassing cache. */
export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw, extractDiscordUserIds(rawText));
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

/**
 * If the prompt string looks like a file path (ends with .md, .txt, or .prompt),
 * read and return the file contents. Otherwise return the string as-is.
 * Relative paths are resolved from the project root (cwd).
 */
export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
