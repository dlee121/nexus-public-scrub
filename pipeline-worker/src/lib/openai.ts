import OpenAI, { AzureOpenAI, APIError, RateLimitError } from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

// Primary: our own Azure OpenAI resource — same `ruby-openai-1` deployment
// the rest of Ruby uses (mirrors the canonical pattern in
// [target-repo-api]'s src/ai/inference_apis/openai_api.py and
// src/utils/vizops_client.py). Lazily constructed so a forge-worker without
// Azure creds set still boots — it just falls through to GitHub Models if
// configured, or throws on first call if neither is set.
let azureClient: AzureOpenAI | null = null;
let azureClientInitFailed = false;

function getAzureClient(): AzureOpenAI | null {
  if (azureClient || azureClientInitFailed) {
    return azureClient;
  }
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  if (!endpoint || !apiKey) {
    azureClientInitFailed = true;
    return null;
  }
  try {
    azureClient = new AzureOpenAI({
      endpoint,
      apiKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2025-03-01-preview',
    });
    return azureClient;
  } catch (err) {
    azureClientInitFailed = true;
    console.warn('[openai] failed to initialize Azure client:', err);
    return null;
  }
}

// Fallback: GitHub Models (free tier, GITHUB_TOKEN auth, OpenAI-compatible).
// Subject to a 50 calls / 86400s UserByModelByDay quota that exhausts
// quickly on multi-ticket runs, which is exactly why Azure is now primary.
// Kept as a fallback so a worker booted without Azure creds (e.g. ad-hoc
// local debugging) can still complete a single-ticket run.
let githubModelsClient: OpenAI | null = null;
let githubModelsClientInitFailed = false;

function getGithubModelsClient(): OpenAI | null {
  if (githubModelsClient || githubModelsClientInitFailed) {
    return githubModelsClient;
  }
  if (!process.env.GITHUB_TOKEN) {
    githubModelsClientInitFailed = true;
    return null;
  }
  try {
    githubModelsClient = new OpenAI({
      apiKey: process.env.GITHUB_TOKEN,
      baseURL: 'https://models.inference.ai.azure.com',
    });
    return githubModelsClient;
  } catch (err) {
    githubModelsClientInitFailed = true;
    console.warn('[openai] failed to initialize GitHub Models fallback client:', err);
    return null;
  }
}

// 429 (RateLimitError) and any 5xx are the two failure shapes worth
// retrying against the secondary provider. Auth/4xx other than 429
// indicate a config bug — re-throwing is the right behavior.
function isRetryableUpstreamFailure(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    return status === 429 || status >= 500;
  }
  return false;
}

// Translate a generic model name into the Azure deployment name. Azure
// deployments under `ruby-openai-1` are named identically to OpenAI
// (`gpt-4.1`, `gpt-4.1-mini`), so the default is identity.
// AZURE_OPENAI_MODEL_OVERRIDE rewrites this if a deployment is renamed
// without re-tagging upstream call sites.
function resolveAzureModel(model: string): string {
  return process.env.AZURE_OPENAI_MODEL_OVERRIDE || model;
}

async function runChatCompletion(
  params: ChatCompletionCreateParamsNonStreaming,
): Promise<string> {
  const azure = getAzureClient();
  if (azure) {
    try {
      const azureParams: ChatCompletionCreateParamsNonStreaming = {
        ...params,
        model: resolveAzureModel(params.model),
      };
      const resp = await azure.chat.completions.create(azureParams);
      return resp.choices[0]?.message?.content ?? '';
    } catch (err) {
      if (!isRetryableUpstreamFailure(err)) throw err;
      const fallback = getGithubModelsClient();
      if (!fallback) throw err;
      const status = err instanceof APIError ? err.status : 'unknown';
      console.warn(
        `[openai] Azure returned ${status}; falling back to GitHub Models (model=${params.model})`,
      );
      const resp = await fallback.chat.completions.create(params);
      return resp.choices[0]?.message?.content ?? '';
    }
  }

  const fallback = getGithubModelsClient();
  if (!fallback) {
    throw new Error(
      '[openai] No provider configured. Set AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY ' +
      '(preferred) or GITHUB_TOKEN (fallback) on the worker.',
    );
  }
  const resp = await fallback.chat.completions.create(params);
  return resp.choices[0]?.message?.content ?? '';
}

export interface CallOpenAIOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

/**
 * Generic GPT-4.1 call. Routes through Azure when AZURE_OPENAI_* env vars
 * are set; otherwise (or on 429/5xx from Azure) falls back to GitHub Models
 * if GITHUB_TOKEN is set.
 */
export async function callOpenAI(
  messages: ChatCompletionMessageParam[],
  opts: CallOpenAIOptions = {},
): Promise<string> {
  const params: ChatCompletionCreateParamsNonStreaming = {
    model: opts.model ?? 'gpt-4.1',
    messages,
    max_tokens: opts.maxTokens ?? 2000,
  };
  if (opts.temperature !== undefined) {
    params.temperature = opts.temperature;
  }
  if (opts.jsonMode) {
    params.response_format = { type: 'json_object' };
  }
  return runChatCompletion(params);
}

/**
 * Review an implementation plan via GPT-4.1.
 *
 * Errors propagate. The previous silent-catch fallback returned a fake
 * `verdict:"pass"` JSON which masked auth failures, rate limits, and
 * network errors — the caller had no way to distinguish "GPT actually
 * approved the plan" from "GPT was unreachable, no review happened."
 * That hid bad plans from review and was a real silent-failure
 * footgun. Let it throw; Temporal's activity retry handles transient
 * issues, and the workflow's outer catch posts a "🔥 BLOCKED" Slack
 * alert on persistent failure (see PipelineWorkflow.ts:470).
 */
export async function reviewPlan(plan: string): Promise<string> {
  const raw = await runChatCompletion({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content:
          'You are a senior software engineer reviewing an implementation plan. Respond with valid JSON only.',
      },
      {
        role: 'user',
        content: `Review this implementation plan and identify issues.\n\nPlan:\n${plan}\n\nReturn JSON: {"verdict":"pass"|"fail","issues":[{"severity":"critical"|"high"|"medium","description":"..."}],"critique":"..."}`,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
  });
  return raw || '{}';
}

/**
 * Review a code diff via GPT-4.1. Same silent-catch removal as reviewPlan
 * — see that function's docstring for rationale.
 */
export async function reviewDiff(diff: string, ticketTitle: string): Promise<string> {
  const raw = await runChatCompletion({
    model: 'gpt-4.1',
    messages: [
      {
        role: 'system',
        content:
          'You are a senior software engineer doing a code review. Respond with valid JSON only.',
      },
      {
        role: 'user',
        content: `Review this diff for ticket: "${ticketTitle}"\n\nDiff (first 12000 chars):\n${diff.slice(0, 12000)}\n\nReturn JSON: {"verdict":"pass"|"fail","issues":[{"severity":"critical"|"high"|"medium","description":"...","file":"...","line":0}],"summary":"..."}`,
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1500,
  });
  return raw || '{}';
}
