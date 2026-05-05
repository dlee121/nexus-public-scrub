import { mkdir, readFile, writeFile, rm, stat } from "fs/promises";
import { join, isAbsolute } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import { getSession, createSession, incrementTurn, markCompactWarned, resetTurnCount, backupSession } from "./sessions";
import {
  getThreadSession,
  createThreadSession,
  incrementThreadTurn,
  markThreadCompactWarned,
  resetThreadTurnCount,
  removeThreadSession,
} from "./sessionManager";
import { getSettings, type ModelConfig, type SecurityConfig } from "./config";
import { buildClockPromptPrefix } from "./timezone";
import { selectModel } from "./model-router";

const LOGS_DIR = join(process.cwd(), ".claude/claudeclaw/logs");
const SESSION_LOCK = join(process.cwd(), ".claude/claudeclaw/session.lock");
const DEFAULT_PROMPTS_DIR = join(import.meta.dir, "..", "prompts");
// Project-level prompt overrides live here (gitignored, user-owned)
const PROJECT_PROMPTS_DIR = join(process.cwd(), ".claude", "claudeclaw", "prompts");
const HEARTBEAT_PROMPT_FILE = join(DEFAULT_PROMPTS_DIR, "heartbeat", "HEARTBEAT.md");

function getPromptsDir(): string {
  try {
    const { promptsDir } = getSettings();
    if (promptsDir) {
      return isAbsolute(promptsDir) ? promptsDir : join(process.cwd(), promptsDir);
    }
  } catch {}
  return DEFAULT_PROMPTS_DIR;
}
const PROJECT_CLAUDE_MD = join(process.cwd(), "CLAUDE.md");
const LEGACY_PROJECT_CLAUDE_MD = join(process.cwd(), ".claude", "CLAUDE.md");
const CLAUDECLAW_BLOCK_START = "<!-- claudeclaw:managed:start -->";
const CLAUDECLAW_BLOCK_END = "<!-- claudeclaw:managed:end -->";

// Cross-process session lock using atomic mkdir. Prevents concurrent
// --resume on the same Claude session from different OS processes
// (e.g. daemon heartbeat vs. external `send` command).
const LOCK_PID_FILE = join(SESSION_LOCK, "pid");

async function acquireSessionLock(timeoutMs = 35 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await mkdir(SESSION_LOCK);
      await Bun.write(LOCK_PID_FILE, String(process.pid));
      return;
    } catch {
      try {
        const holder = Number(await Bun.file(LOCK_PID_FILE).text());
        process.kill(holder, 0);
      } catch {
        try { await rm(SESSION_LOCK, { recursive: true }); } catch {}
        continue;
      }
      await Bun.sleep(1000);
    }
  }
  throw new Error(`[session-lock] Timed out after ${timeoutMs}ms`);
}

async function releaseSessionLock(): Promise<void> {
  try { await rm(SESSION_LOCK, { recursive: true }); } catch {}
}

/**
 * Compact configuration.
 * COMPACT_WARN_THRESHOLD: notify user that context is getting large.
 * COMPACT_TIMEOUT_ENABLED: whether to auto-compact on timeout (exit 124).
 */
const COMPACT_WARN_THRESHOLD = 25;
const COMPACT_TIMEOUT_ENABLED = true;
// Compact proactively before resume if turn count exceeds this threshold.
// At 600+ turns the context is large enough that resume API calls can hang silently.
const PROACTIVE_COMPACT_THRESHOLD = 600;
// Compact proactively before resume if the session JSONL file exceeds this
// many bytes. Turn count alone misses sessions that bloat fast (e.g. Forge
// sessions where each turn embeds large code patches + directives —
// ea3f6dce hit 184 MB at only 63 turns, well below PROACTIVE_COMPACT_THRESHOLD,
// so the size guard never fired and the resume API call hung silently for
// the full 30-min timeout). 20 MB is generous: a healthy session of 50–100
// turns rarely exceeds 5–10 MB, but sessions with embedded patches can
// blow past it well before turn 100.
const PROACTIVE_COMPACT_SIZE_BYTES = 20 * 1024 * 1024;
// Watchdog for first token on a resumed session. If no output arrives in this window,
// the session is likely hung on a context-bloated API call.
//
// Lowered from 90s → 30s on 2026-05-03: a 184 MB session can emit an
// initial system event (clearing a 90s watchdog) before the actual API
// response hangs. 30s is enough for healthy resumes; anything taking
// longer should be compacted, not waited on.
const FIRST_TOKEN_WATCHDOG_MS = 30 * 1000;

/**
 * Resolve the on-disk path of a session's JSONL transcript. Claude Code
 * stores these at `~/.claude/projects/<project-slug>/<sessionId>.jsonl`,
 * where the project-slug is `process.cwd()` with `/` replaced by `-`
 * (e.g. `/Users/<user>/Nexus/core` → `-Users-example-Nexus-core`).
 */
function sessionJsonlPath(sessionId: string): string {
  const slug = process.cwd().replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/**
 * Best-effort size lookup of a session's JSONL transcript. Returns 0 on
 * any error (file missing, permissions, race) — caller should treat 0
 * as "couldn't determine, don't trigger size-based compact." stat() is
 * cheap so this is safe to call before every resume.
 */
async function sessionJsonlSizeBytes(sessionId: string): Promise<number> {
  try {
    const s = await stat(sessionJsonlPath(sessionId));
    return s.size;
  } catch {
    return 0;
  }
}

export type CompactEvent =
  | { type: "warn"; turnCount: number }
  | { type: "auto-compact-start" }
  | { type: "auto-compact-done"; success: boolean }
  | { type: "auto-compact-retry"; success: boolean; stdout: string; stderr: string; exitCode: number };

type CompactEventListener = (event: CompactEvent) => void;
const compactListeners: CompactEventListener[] = [];

/** Register a listener for compact-related events (warnings, auto-compact notifications). */
export function onCompactEvent(listener: CompactEventListener): void {
  compactListeners.push(listener);
}

function emitCompactEvent(event: CompactEvent): void {
  for (const listener of compactListeners) {
    try { listener(event); } catch {}
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ActiveRun {
  id: string;
  name: string;
  startedAt: number;
}

const activeRunBuffers = new Map<string, { meta: ActiveRun; chunks: string[] }>();
let runIdCounter = 0;

export function getActiveRuns(): Array<ActiveRun & { elapsedMs: number }> {
  return Array.from(activeRunBuffers.values()).map(({ meta }) => ({
    ...meta,
    elapsedMs: Date.now() - meta.startedAt,
  }));
}

export function getActiveRunOutput(id: string): string | null {
  const entry = activeRunBuffers.get(id);
  return entry ? entry.chunks.join("") : null;
}

// Entities (agent subagent_type values) collected from the last run
let lastRunEntities: string[] = [];

export function getLastRunEntities(): string[] {
  return lastRunEntities;
}

// Count of SUCCESSFUL Slack post-message tool calls Orchestrator made during the
// last run. The Slack inbound handler (src/commands/slack.ts) reads this to
// decide whether to auto-relay Orchestrator's plain-text output: if Orchestrator already
// posted via MCP, the auto-relay would be a duplicate, so we suppress it.
let lastRunSlackPostsMade = 0;

export function getLastRunSlackPostsMade(): number {
  return lastRunSlackPostsMade;
}

interface StreamSummary {
  result: string;
  sessionId: string | null;
  entities: string[];
  /**
   * Count of SUCCESSFUL Slack post tool calls in this run (matches against
   * `mcp__slack__slack_post_message` and `mcp__slack__slack_reply_to_thread`).
   * "Success" = matching tool_result block has `is_error !== true`.
   * The Slack inbound handler suppresses auto-relay when this is > 0.
   */
  slackPostsMade: number;
}

const SLACK_POST_TOOL_NAMES = new Set([
  "mcp__slack__slack_post_message",
  "mcp__slack__slack_reply_to_thread",
]);

function parseStreamEvents(raw: string): StreamSummary {
  const lines = raw.split("\n");
  let result = "";
  let lastAssistantText = "";
  let sessionId: string | null = null;
  const entities = new Set<string>();

  // Track Slack post tool calls by tool_use_id so we can match them against
  // their tool_result blocks. We only count a post as "made" if its result
  // came back without is_error — protects against attributing a failed MCP
  // call as a successful post (which would suppress auto-relay and leave
  // the user with no message at all).
  const pendingSlackPosts = new Map<string, true>();
  let slackPostsMade = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);

      if (event.type === "system" && event.session_id) {
        sessionId = event.session_id;
      }

      if (event.type === "result") {
        if (typeof event.result === "string") result = event.result;
        if (event.session_id) sessionId = event.session_id;
      }

      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        const textParts: string[] = [];
        for (const block of event.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          }
          if (block.type === "tool_use" && block.name === "Agent" && block.input?.subagent_type) {
            entities.add(String(block.input.subagent_type));
          }
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string" &&
            SLACK_POST_TOOL_NAMES.has(block.name)
          ) {
            pendingSlackPosts.set(block.id, true);
          }
        }
        if (textParts.length > 0) lastAssistantText = textParts.join("\n");
      }

      // tool_result blocks arrive on `user` events (Claude Code echoes them
      // back to the model under the user role). Match by tool_use_id.
      if (event.type === "user" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (
            block.type === "tool_result" &&
            typeof block.tool_use_id === "string" &&
            pendingSlackPosts.has(block.tool_use_id)
          ) {
            pendingSlackPosts.delete(block.tool_use_id);
            if (block.is_error !== true) slackPostsMade++;
          }
        }
      }
    } catch {}
  }

  // When result event is empty (e.g. extended thinking with Sonnet 4.6),
  // fall back to the last assistant text content block.
  if (!result) result = lastAssistantText;

  // Final fallback: non-JSON raw output
  if (!result && raw.trim() && !raw.trim().startsWith("{")) {
    result = raw.trim();
  }

  return { result, sessionId, entities: Array.from(entities), slackPostsMade };
}

const RATE_LIMIT_PATTERN = /you(?:’|’)ve hit your limit|out of extra usage/i;

// Match Anthropic's authentication failures from claude-code subprocess output.
// Empirically the CLI emits a few shapes:
//   "Failed to authenticate. API Error: 401 ..."
//   {"type":"error","error":{"type":"authentication_error", ...}}
//   "API Error: 401" with surrounding JSON
// All three should map to the same recovery message.
const AUTH_ERROR_PATTERN =
  /authentication_error|"type"\s*:\s*"authentication_error"|API Error:\s*401|Failed to authenticate/i;

const AUTH_RECOVERY_MESSAGE =
  "⚠️ Auth expired — claude subprocess returned 401 (authentication_error).\n\n" +
  "Recovery (pick the one that matches what just happened):\n" +
  "  • If you just ran /login on the Mac (fresh OAuth chain): \n" +
  "      scripts/sync-claude-creds.sh --ec2-bootstrap\n" +
  "    This pushes the new Mac Keychain creds to EC2 so the canonical\n" +
  "    refresh chain is reseeded.\n" +
  "  • Otherwise (Mac is just out of sync with EC2): \n" +
  "      scripts/pull-claude-creds-from-ec2.sh --force\n" +
  "    This pulls fresh creds from EC2 (the canonical source) into Mac\n" +
  "    Keychain, overriding the newer-Keychain safety check.\n\n" +
  "Then retry your message.";

// Serial queue — prevents concurrent --resume on the same session
// Global queue for non-thread messages (backward compatible)
let globalQueue: Promise<unknown> = Promise.resolve();
// Per-thread queues — each thread runs independently in parallel
const threadQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(fn: () => Promise<T>, threadId?: string): Promise<T> {
  if (threadId) {
    const current = threadQueues.get(threadId) ?? Promise.resolve();
    const task = current.then(fn, fn);
    threadQueues.set(threadId, task.catch(() => {}));
    return task;
  }
  const task = globalQueue.then(fn, fn);
  globalQueue = task.catch(() => {});
  return task;
}

function extractRateLimitMessage(stdout: string, stderr: string): string | null {
  const candidates = [stdout, stderr];
  for (const text of candidates) {
    const trimmed = text.trim();
    if (trimmed && RATE_LIMIT_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Detect a claude-subprocess auth failure (401 / authentication_error) in
 * either stream-json output or stderr. Returns the canned recovery message
 * when a match is found, null otherwise. We swap this in for the raw JSON
 * error before relaying so the user gets actionable instructions instead
 * of {"type":"error","error":{"type":"authentication_error",...}}.
 */
function extractAuthErrorMessage(stdout: string, stderr: string): string | null {
  if (AUTH_ERROR_PATTERN.test(stdout) || AUTH_ERROR_PATTERN.test(stderr)) {
    return AUTH_RECOVERY_MESSAGE;
  }
  return null;
}

function sameModelConfig(a: ModelConfig, b: ModelConfig): boolean {
  return a.model.trim().toLowerCase() === b.model.trim().toLowerCase() && a.api.trim() === b.api.trim();
}

function hasModelConfig(value: ModelConfig): boolean {
  return value.model.trim().length > 0 || value.api.trim().length > 0;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /enoent|no such file or directory/i.test(message);
}

function buildChildEnv(baseEnv: Record<string, string>, model: string, api: string): Record<string, string> {
  const childEnv: Record<string, string> = { ...baseEnv };
  const normalizedModel = model.trim().toLowerCase();

  if (api.trim()) childEnv.ANTHROPIC_AUTH_TOKEN = api.trim();

  if (normalizedModel === "glm") {
    childEnv.ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic";
    childEnv.API_TIMEOUT_MS = "3000000";
  }

  return childEnv;
}

/** Default timeout for a single Claude Code invocation (30 minutes). */
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Optional per-call overrides for runUserMessage / run / execClaude.
 *
 * `timeoutMs` overrides the default Claude session timeout
 * (CLAUDE_TIMEOUT_MS or settings.sessionTimeoutMs). Used by inject
 * (delegated-task-result) sessions to cap how long they can hold the
 * cross-process session lock. Without an override they'd block any
 * incoming user message for up to 30 minutes — observed today
 * blocking a Slack message for 35 min until acquireSessionLock itself
 * timed out (exit 124, user got nothing).
 */
export interface RunOpts {
  timeoutMs?: number;
}

async function runClaudeOnce(
  baseArgs: string[],
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  onChunk?: (chunk: string) => void,
  timeoutMs: number = CLAUDE_TIMEOUT_MS,
  firstTokenWatchdogMs: number = 0
): Promise<{ rawStdout: string; stderr: string; exitCode: number }> {
  const args = [...baseArgs];
  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(baseEnv, model, api),
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Claude session timed out after ${timeoutMs / 1000}s`)), timeoutMs);
  });

  // Holds streamed chunks so the catch block can return partial output on timeout
  const streamingChunks: string[] = [];

  try {
    let rawStdout: string;

    if (onChunk) {
      // Streaming mode: deliver chunks as they arrive, with timeout guard
      const chunks = streamingChunks;
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let firstChunkSeen = false;
      let firstTokenTimer: ReturnType<typeof setTimeout> | null = null;
      let firstTokenReject: ((e: Error) => void) | null = null;
      const firstTokenPromise = firstTokenWatchdogMs > 0
        ? new Promise<never>((_, reject) => {
            firstTokenReject = reject;
            firstTokenTimer = setTimeout(() => {
              if (!firstChunkSeen) {
                reject(new Error(`No response from Claude within ${firstTokenWatchdogMs / 1000}s on resume — session likely hung on context bloat`));
              }
            }, firstTokenWatchdogMs);
          })
        : null;
      const readLoop = async (): Promise<void> => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            if (firstTokenTimer) clearTimeout(firstTokenTimer);
          }
          chunks.push(text);
          onChunk(text);
        }
      };
      const races: Promise<unknown>[] = [readLoop(), timeoutPromise];
      if (firstTokenPromise) races.push(firstTokenPromise);
      await Promise.race(races);
      rawStdout = chunks.join("");
    } else {
      [rawStdout] = await Promise.race([
        Promise.all([new Response(proc.stdout).text()]),
        timeoutPromise,
      ]) as [string];
    }

    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    return {
      rawStdout,
      stderr,
      exitCode: proc.exitCode ?? 1,
    };
  } catch (err) {
    // Kill the hung process
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);

    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${new Date().toLocaleTimeString()}] ${message}`);

    return {
      // Preserve any chunks accumulated before the timeout so downstream
      // parseStreamEvents can extract clean text rather than seeing empty output.
      // Only populated in streaming mode (onChunk provided); empty string otherwise.
      rawStdout: onChunk ? streamingChunks.join("") : "",
      stderr: message,
      exitCode: 124,
    };
  }
}

const PROJECT_DIR = process.cwd();

const DIR_SCOPE_PROMPT = [
  `CRITICAL SECURITY CONSTRAINT: You are scoped to the project directory: ${PROJECT_DIR}`,
  "You MUST NOT read, write, edit, or delete any file outside this directory.",
  "You MUST NOT run bash commands that modify anything outside this directory (no cd /, no /etc, no ~/, no ../.. escapes).",
  "If a request requires accessing files outside the project, refuse and explain why.",
].join("\n");

export async function ensureProjectClaudeMd(): Promise<void> {
  // Preflight-only initialization: never rewrite an existing project CLAUDE.md.
  if (existsSync(PROJECT_CLAUDE_MD)) return;

  const promptContent = (await loadPrompts()).trim();
  const managedBlock = [
    CLAUDECLAW_BLOCK_START,
    promptContent,
    CLAUDECLAW_BLOCK_END,
  ].join("\n");

  let content = "";

  if (existsSync(LEGACY_PROJECT_CLAUDE_MD)) {
    try {
      const legacy = await readFile(LEGACY_PROJECT_CLAUDE_MD, "utf8");
      content = legacy.trim();
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read legacy .claude/CLAUDE.md:`, e);
      return;
    }
  }

  const normalized = content.trim();
  const hasManagedBlock =
    normalized.includes(CLAUDECLAW_BLOCK_START) && normalized.includes(CLAUDECLAW_BLOCK_END);
  const managedPattern = new RegExp(
    `${CLAUDECLAW_BLOCK_START}[\\s\\S]*?${CLAUDECLAW_BLOCK_END}`,
    "m"
  );

  const merged = hasManagedBlock
    ? `${normalized.replace(managedPattern, managedBlock)}\n`
    : normalized
      ? `${normalized}\n\n${managedBlock}\n`
      : `${managedBlock}\n`;

  try {
    await writeFile(PROJECT_CLAUDE_MD, merged, "utf8");
  } catch (e) {
    console.error(`[${new Date().toLocaleTimeString()}] Failed to write project CLAUDE.md:`, e);
  }
}

function buildSecurityArgs(security: SecurityConfig): string[] {
  const args: string[] = ["--dangerously-skip-permissions"];

  switch (security.level) {
    case "locked":
      args.push("--tools", "Read,Grep,Glob");
      break;
    case "strict":
      args.push("--disallowedTools", "Bash,WebSearch,WebFetch");
      break;
    case "moderate":
      // all tools available, scoped to project dir via system prompt
      break;
    case "unrestricted":
      // all tools, no directory restriction
      break;
  }

  if (security.allowedTools.length > 0) {
    args.push("--allowedTools", security.allowedTools.join(" "));
  }
  if (security.disallowedTools.length > 0) {
    args.push("--disallowedTools", security.disallowedTools.join(" "));
  }

  return args;
}

/** Load and concatenate all prompt files from the prompts directory. */
async function loadPrompts(): Promise<string> {
  const promptsDir = getPromptsDir();
  const selectedPromptFiles = [
    join(promptsDir, "IDENTITY.md"),
    join(promptsDir, "USER.md"),
    join(promptsDir, "SOUL.md"),
  ];
  const parts: string[] = [];

  for (const file of selectedPromptFiles) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) parts.push(content.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read prompt file ${file}:`, e);
    }
  }

  return parts.join("\n\n");
}

/**
 * Load the heartbeat prompt template.
 * Project-level override takes precedence: place a file at
 * .claude/claudeclaw/prompts/HEARTBEAT.md to fully replace the built-in template.
 */
export async function loadHeartbeatPromptTemplate(): Promise<string> {
  const projectOverride = join(PROJECT_PROMPTS_DIR, "HEARTBEAT.md");
  const installOverride = join(getPromptsDir(), "heartbeat", "HEARTBEAT.md");
  for (const file of [projectOverride, installOverride, HEARTBEAT_PROMPT_FILE]) {
    try {
      const content = await Bun.file(file).text();
      if (content.trim()) return content.trim();
    } catch (e) {
      if (!isNotFoundError(e)) {
        console.warn(`[${new Date().toLocaleTimeString()}] Failed to read heartbeat prompt file ${file}:`, e);
      }
    }
  }
  return "";
}

/** Run /compact on the current session to reduce context size. */
export async function runCompact(
  sessionId: string,
  model: string,
  api: string,
  baseEnv: Record<string, string>,
  securityArgs: string[],
  timeoutMs: number
): Promise<boolean> {
  const compactArgs = [
    "claude", "-p", "/compact",
    "--output-format", "text",
    "--resume", sessionId,
    ...securityArgs,
  ];
  console.log(`[${new Date().toLocaleTimeString()}] Running /compact on session ${sessionId.slice(0, 8)}...`);
  const result = await runClaudeOnce(compactArgs, model, api, baseEnv, undefined, timeoutMs);
  const success = result.exitCode === 0;
  console.log(`[${new Date().toLocaleTimeString()}] Compact ${success ? "succeeded" : `failed (exit ${result.exitCode})`}`);
  return success;
}

/**
 * High-level compact: resolves session + settings internally.
 * Returns { success, message }.
 */
export async function compactCurrentSession(): Promise<{ success: boolean; message: string }> {
  const existing = await getSession();
  if (!existing) return { success: false, message: "No active session to compact." };

  const settings = getSettings();
  const securityArgs = buildSecurityArgs(settings.security);
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;
  const timeoutMs = (settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS;

  const ok = await runCompact(
    existing.sessionId,
    settings.model,
    settings.api,
    baseEnv,
    securityArgs,
    timeoutMs
  );

  return ok
    ? { success: true, message: `✅ Session compact complete (${existing.sessionId.slice(0, 8)})` }
    : { success: false, message: `❌ Compact failed (${existing.sessionId.slice(0, 8)})` };
}

async function execClaude(name: string, prompt: string, threadId?: string, opts?: RunOpts): Promise<RunResult> {
  await acquireSessionLock();
  let runId: string | undefined;
  try {
  await mkdir(LOGS_DIR, { recursive: true });

  let existing = threadId
    ? await getThreadSession(threadId)
    : await getSession();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOGS_DIR, `${name}-${timestamp}.log`);

  const settings = getSettings();
  const { security, model, api, fallback, agentic } = settings;

  // Periodic session reset. Even with proactive compact at
  // PROACTIVE_COMPACT_THRESHOLD, very long sessions degrade — compact
  // preserves the thread but not its coherence, and accumulated turn-noise
  // bleeds through. Once turnCount crosses sessionResetThreshold, archive
  // the session (so it's recoverable) and force the next invocation to
  // start fresh by clearing `existing`. Threads use removeThreadSession
  // since there is no per-thread backup file.
  const resetThreshold = settings.sessionResetThreshold > 0
    ? settings.sessionResetThreshold
    : 0;
  if (existing && resetThreshold > 0 && existing.turnCount >= resetThreshold) {
    console.log(
      `[${new Date().toLocaleTimeString()}] Session reset: turn count ${existing.turnCount} >= threshold ${resetThreshold} — archiving and starting fresh`
    );
    if (threadId) {
      await removeThreadSession(threadId);
    } else {
      const backupName = await backupSession();
      if (backupName) {
        console.log(`[${new Date().toLocaleTimeString()}] Archived previous session as ${backupName}`);
      }
    }
    existing = null;
  }
  const isNew = !existing;

  // Determine which model to use based on agentic routing
  let primaryConfig: ModelConfig;
  let taskType = "unknown";
  let routingReasoning = "";

  if (agentic.enabled) {
    const routing = selectModel(prompt, agentic.modes, agentic.defaultMode);
    primaryConfig = { model: routing.model, api };
    taskType = routing.taskType;
    routingReasoning = routing.reasoning;
    console.log(
      `[${new Date().toLocaleTimeString()}] Agentic routing: ${routing.taskType} → ${routing.model} (${routing.reasoning})`
    );
  } else {
    primaryConfig = { model, api };
  }

  const fallbackConfig: ModelConfig = {
    model: fallback?.model ?? "",
    api: fallback?.api ?? "",
  };
  const securityArgs = buildSecurityArgs(security);
  // Per-call override (used by inject sessions to cap lock-hold time)
  // wins over global setting + module default.
  const timeoutMs = opts?.timeoutMs ?? ((settings as any).sessionTimeoutMs || CLAUDE_TIMEOUT_MS);

  runId = String(++runIdCounter);
  const activeChunks: string[] = [];
  activeRunBuffers.set(runId, { meta: { id: runId, name, startedAt: Date.now() }, chunks: activeChunks });
  const onChunk = (chunk: string) => { activeChunks.push(chunk); };

  console.log(
    `[${new Date().toLocaleTimeString()}] Running: ${name} (${existing ? `resume ${existing.sessionId.slice(0, 8)}` : "new session"}, security: ${security.level})`
  );

  const args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (existing) {
    args.push("--resume", existing.sessionId);
  }

  // Build the appended system prompt: prompt files + directory scoping
  // This is passed on EVERY invocation (not just new sessions) because
  // --append-system-prompt does not persist across --resume.
  const promptContent = await loadPrompts();
  const appendParts: string[] = [
    "You are running inside Nexus.",
  ];
  if (promptContent) appendParts.push(promptContent);

  // Load the project's CLAUDE.md if it exists
  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch (e) {
      console.error(`[${new Date().toLocaleTimeString()}] Failed to read project CLAUDE.md:`, e);
    }
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  // Strip CLAUDECODE env var so child claude processes don't think they're nested
  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const baseEnv = { ...cleanEnv } as Record<string, string>;

  // Proactive compact: if the session is old or the JSONL transcript is
  // already large, compact before resuming. Either condition alone can
  // cause a silent API hang on resume — we observed turn=63 / size=184MB
  // hang for the full 30-min timeout because turnCount alone (<600) never
  // triggered the existing guard. Now we trigger on EITHER axis.
  let proactiveSize = 0;
  let proactiveReason: "turns" | "size" | null = null;
  if (!isNew && existing) {
    if (existing.turnCount >= PROACTIVE_COMPACT_THRESHOLD) {
      proactiveReason = "turns";
    } else {
      proactiveSize = await sessionJsonlSizeBytes(existing.sessionId);
      if (proactiveSize >= PROACTIVE_COMPACT_SIZE_BYTES) {
        proactiveReason = "size";
      }
    }
  }
  if (proactiveReason && existing) {
    const sizeMb = (proactiveSize / 1024 / 1024).toFixed(1);
    console.log(
      `[${new Date().toLocaleTimeString()}] Proactive compact triggered (reason=${proactiveReason}, ` +
      `turnCount=${existing.turnCount}, sessionSize=${sizeMb}MB) — compacting before resume`
    );
    emitCompactEvent({ type: "auto-compact-start" });
    const proactiveCompactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs
    );
    emitCompactEvent({ type: "auto-compact-done", success: proactiveCompactOk });
    if (proactiveCompactOk) {
      // Reset turnCount so the threshold check doesn't fire on every
      // subsequent turn forever. Without this, the monotonic counter stays
      // above 600 after the first compact and we re-compact-and-resume on
      // every turn, burning tokens compacting an already-compacted session.
      if (threadId) {
        await resetThreadTurnCount(threadId);
      } else {
        await resetTurnCount();
      }
      existing.turnCount = 0;
      existing.compactWarned = false;
    } else {
      console.warn(`[${new Date().toLocaleTimeString()}] Proactive compact failed — proceeding anyway`);
    }
  }

  let exec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, onChunk, timeoutMs, !isNew ? FIRST_TOKEN_WATCHDOG_MS : 0);
  const primaryRateLimit = extractRateLimitMessage(exec.rawStdout, exec.stderr);
  let usedFallback = false;

  if (primaryRateLimit && hasModelConfig(fallbackConfig) && !sameModelConfig(primaryConfig, fallbackConfig)) {
    console.warn(
      `[${new Date().toLocaleTimeString()}] Claude limit reached; retrying with fallback${fallbackConfig.model ? ` (${fallbackConfig.model})` : ""}...`
    );
    exec = await runClaudeOnce(args, fallbackConfig.model, fallbackConfig.api, baseEnv, onChunk, timeoutMs);
    usedFallback = true;
  }

  const rawStdout = exec.rawStdout;
  const stderr = exec.stderr;
  const exitCode = exec.exitCode;

  // Parse stream-json events to extract result text, session_id, and agent entity types
  const streamSummary = parseStreamEvents(rawStdout);
  lastRunEntities = streamSummary.entities;
  lastRunSlackPostsMade = streamSummary.slackPostsMade;

  let stdout = streamSummary.result;
  let sessionId = existing?.sessionId ?? "unknown";
  // Check raw output for rate limit messages when extracted result is empty
  const rateLimitMessage = extractRateLimitMessage(stdout || rawStdout, stderr);

  if (rateLimitMessage) {
    stdout = rateLimitMessage;
  }

  // Auth-failure substitution: when claude subprocess returns a 401, the
  // raw JSON error is useless to the operator. Swap in actionable recovery
  // steps (which differ from rate-limit guidance — rate limits resolve
  // themselves; auth requires manual cred re-sync). Skip if rate-limit
  // already matched, since rate-limit messages can incidentally include
  // numeric tokens that look like 401s.
  if (!rateLimitMessage) {
    const authMessage = extractAuthErrorMessage(stdout || rawStdout, stderr);
    if (authMessage) {
      stdout = authMessage;
    }
  }

  if (!rateLimitMessage && isNew && exitCode === 0) {
    if (streamSummary.sessionId) {
      sessionId = streamSummary.sessionId;
      if (threadId) {
        await createThreadSession(threadId, sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Thread session created: ${sessionId} (thread ${threadId.slice(0, 8)})`);
      } else {
        await createSession(sessionId);
        console.log(`[${new Date().toLocaleTimeString()}] Session created: ${sessionId}`);
      }
    } else {
      console.error(`[${new Date().toLocaleTimeString()}] No session_id found in stream-json output`);
    }
  }

  const result: RunResult = {
    stdout,
    stderr,
    exitCode,
  };

  const output = [
    `# ${name}`,
    `Date: ${new Date().toISOString()}`,
    `Session: ${sessionId} (${isNew ? "new" : "resumed"})`,
    `Model config: ${usedFallback ? "fallback" : "primary"}`,
    ...(agentic.enabled ? [`Task type: ${taskType}`, `Routing: ${routingReasoning}`] : []),
    `Prompt: ${prompt}`,
    `Exit code: ${result.exitCode}`,
    "",
    "## Output",
    stdout,
    ...(stderr ? ["## Stderr", stderr] : []),
  ].join("\n");

  await Bun.write(logFile, output);
  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name} → ${logFile}`);

  // --- Auto-compact on timeout (exit 124) ---
  // exit 124 = watchdog or session-timeout fired. With the lowered
  // FIRST_TOKEN_WATCHDOG_MS (30s), this fires fast on a context-bloated
  // resume; we then compact + retry in the same turn, so the user sees a
  // single recovery cycle instead of a 30-min stall. Log the JSONL size
  // when compacting so the operator can see why.
  if (COMPACT_TIMEOUT_ENABLED && exitCode === 124 && !isNew && existing) {
    const sizeAtTimeoutBytes = await sessionJsonlSizeBytes(existing.sessionId);
    const sizeAtTimeoutMb = (sizeAtTimeoutBytes / 1024 / 1024).toFixed(1);
    if (sizeAtTimeoutBytes >= PROACTIVE_COMPACT_SIZE_BYTES) {
      console.log(
        `[${new Date().toLocaleTimeString()}] Timeout/watchdog fired on a large session (${sizeAtTimeoutMb}MB ≥ ${PROACTIVE_COMPACT_SIZE_BYTES / 1024 / 1024}MB threshold) — compact + retry`
      );
    } else {
      console.log(
        `[${new Date().toLocaleTimeString()}] Timeout/watchdog fired (sessionSize=${sizeAtTimeoutMb}MB) — compact + retry`
      );
    }
    emitCompactEvent({ type: "auto-compact-start" });
    const compactOk = await runCompact(
      existing.sessionId,
      primaryConfig.model,
      primaryConfig.api,
      baseEnv,
      securityArgs,
      timeoutMs
    );
    emitCompactEvent({ type: "auto-compact-done", success: compactOk });

    if (compactOk) {
      // Mirror the proactive-compact reset path (see ~line 700). Without
      // this, both downstream branches were latent compact-loop bugs:
      //   - the double-timeout early return (exit 124 on retry) returned
      //     with turnCount still above PROACTIVE_COMPACT_THRESHOLD, so the
      //     next message would compact AGAIN before resuming.
      //   - the successful-retry path only incremented turnCount, leaving
      //     it at e.g. 601 instead of 1 — defeating the compact's whole
      //     purpose for every subsequent turn.
      // One reset before retry covers both exit paths.
      if (threadId) {
        await resetThreadTurnCount(threadId);
      } else {
        await resetTurnCount();
      }
      existing.turnCount = 0;
      existing.compactWarned = false;

      console.log(`[${new Date().toLocaleTimeString()}] Retrying ${name} after compact...`);
      const retryExec = await runClaudeOnce(args, primaryConfig.model, primaryConfig.api, baseEnv, onChunk, timeoutMs);
      if (retryExec.exitCode === 124) {
        return {
          stdout: "This task timed out twice and couldn't complete within the session time limit. Please try re-sending — consider breaking it into smaller steps if it involves multiple agent dispatches.",
          stderr: retryExec.stderr,
          exitCode: 124,
        };
      }
      const retrySummary = parseStreamEvents(retryExec.rawStdout);
      lastRunEntities = retrySummary.entities;
      lastRunSlackPostsMade = retrySummary.slackPostsMade;
      const retryResult: RunResult = {
        stdout: retrySummary.result,
        stderr: retryExec.stderr,
        exitCode: retryExec.exitCode,
      };
      emitCompactEvent({
        type: "auto-compact-retry",
        success: retryExec.exitCode === 0,
        stdout: retryResult.stdout,
        stderr: retryResult.stderr,
        exitCode: retryResult.exitCode,
      });

      if (retryExec.exitCode === 0) {
        const count = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
        console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${count} (after compact + retry)`);
      }
      return retryResult;
    }
  }

  // --- Turn tracking & compact warning ---
  if (exitCode === 0 && !isNew) {
    const turnCount = threadId ? await incrementThreadTurn(threadId) : await incrementTurn();
    console.log(`[${new Date().toLocaleTimeString()}] Turn count: ${turnCount}${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`);

    if (turnCount >= COMPACT_WARN_THRESHOLD && existing && !existing.compactWarned) {
      if (threadId) {
        await markThreadCompactWarned(threadId);
      } else {
        await markCompactWarned();
      }
      emitCompactEvent({ type: "warn", turnCount });
    }
  }

  return result;
  } finally {
    if (runId !== undefined) activeRunBuffers.delete(runId);
    await releaseSessionLock();
  }
}

export async function run(name: string, prompt: string, threadId?: string, opts?: RunOpts): Promise<RunResult> {
  return enqueue(() => execClaude(name, prompt, threadId, opts), threadId);
}

async function streamClaude(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void
): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });

  const existing = await getSession();
  const { security, model, api } = getSettings();
  const securityArgs = buildSecurityArgs(security);

  // stream-json gives us events as they happen — text before tool calls,
  // so we can unblock the UI as soon as Claude acknowledges, not after sub-agents finish.
  // --verbose is required for stream-json to produce output in -p (print) mode.
  const args = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", ...securityArgs];

  if (existing) args.push("--resume", existing.sessionId);

  const promptContent = await loadPrompts();
  const appendParts: string[] = ["You are running inside Nexus."];
  if (promptContent) appendParts.push(promptContent);

  if (existsSync(PROJECT_CLAUDE_MD)) {
    try {
      const claudeMd = await Bun.file(PROJECT_CLAUDE_MD).text();
      if (claudeMd.trim()) appendParts.push(claudeMd.trim());
    } catch {}
  }

  if (security.level !== "unrestricted") appendParts.push(DIR_SCOPE_PROMPT);
  if (appendParts.length > 0) {
    args.push("--append-system-prompt", appendParts.join("\n\n"));
  }

  const normalizedModel = model.trim().toLowerCase();
  if (model.trim() && normalizedModel !== "glm") args.push("--model", model.trim());

  const { CLAUDECODE: _, ...cleanEnv } = process.env;
  const childEnv = buildChildEnv(cleanEnv as Record<string, string>, model, api);

  console.log(`[${new Date().toLocaleTimeString()}] Running: ${name} (stream-json, session: ${existing?.sessionId?.slice(0, 8) ?? "new"})`);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv,
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let unblocked = false;
  let textEmitted = false;

  const maybeUnblock = () => {
    if (!unblocked) {
      unblocked = true;
      onUnblock();
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // Parse complete newline-delimited JSON events
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;

        if (event.type === "system" && (event.subtype === "init" || event.session_id)) {
          // Capture session ID for new sessions
          const sid = event.session_id as string | undefined;
          if (sid && !existing) {
            await createSession(sid);
            console.log(`[${new Date().toLocaleTimeString()}] Session created (stream-json): ${sid}`);
          }
        } else if (event.type === "assistant") {
          // Text and tool_use blocks from the assistant
          type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
          const msg = event.message as { content?: ContentBlock[] } | undefined;
          const blocks = msg?.content ?? [];
          let hasActivity = false;
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              onChunk(block.text);
              textEmitted = true;
              hasActivity = true;
            } else if (block.type === "tool_use") {
              hasActivity = true;
            }
          }
          if (hasActivity) maybeUnblock();
        } else if (event.type === "tool_use") {
          // Top-level tool_use event (some stream-json versions) — unblock the UI
          maybeUnblock();
        } else if (event.type === "result") {
          // Final result event — emit text as fallback if no assistant text was seen
          const resultText = (event as Record<string, unknown>).result as string | undefined;
          if (resultText && !textEmitted) {
            onChunk(resultText);
          }
          maybeUnblock();
        }
      } catch {}
    }
  }

  await proc.exited;
  // Ensure unblock fires even if something unexpected happened
  maybeUnblock();

  console.log(`[${new Date().toLocaleTimeString()}] Done: ${name}`);
}

export async function streamUserMessage(
  name: string,
  prompt: string,
  onChunk: (text: string) => void,
  onUnblock: () => void
): Promise<void> {
  return enqueue(() => streamClaude(name, prefixUserMessageWithClock(prompt), onChunk, onUnblock));
}

function prefixUserMessageWithClock(prompt: string): string {
  try {
    const settings = getSettings();
    const prefix = buildClockPromptPrefix(new Date(), settings.timezoneOffsetMinutes);
    return `${prefix}\n${prompt}`;
  } catch {
    const prefix = buildClockPromptPrefix(new Date(), 0);
    return `${prefix}\n${prompt}`;
  }
}

export async function runUserMessage(name: string, prompt: string, threadId?: string, opts?: RunOpts): Promise<RunResult> {
  return run(name, prefixUserMessageWithClock(prompt), threadId, opts);
}

/**
 * Bootstrap the session: fires Claude with the system prompt so the
 * session is created immediately. No-op if a session already exists.
 */
export async function bootstrap(): Promise<void> {
  const existing = await getSession();
  if (existing) return;

  const prompt = getSettings().bootstrapPrompt || "Wakeup, my friend!";
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrapping new session...`);
  await execClaude("bootstrap", prompt);
  console.log(`[${new Date().toLocaleTimeString()}] Bootstrap complete — session is live.`);
}
