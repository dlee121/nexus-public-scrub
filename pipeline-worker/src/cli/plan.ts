import { callOpenAI } from '../lib/openai';
import { getAllRepoConfigs } from '../config';
import type { WavePlan } from '../types';
import {
  assertWavePlan,
  formatRepoCatalog,
} from './plan-validation';

// Re-export the validation surface so existing imports from `./plan`
// keep working (and tests can import directly from `./plan-validation`
// without dragging in the OpenAI client).
export { assertTicket, assertWavePlan, formatRepoCatalog } from './plan-validation';

function buildSystemPrompt(repoCatalog: string): string {
  return `You are a staff-level software engineer who decomposes a natural-language instruction into an executable WavePlan for the Forge pipeline.

Forge spans multiple repositories. Every ticket must select exactly one
target repo from the catalog below. If the instruction touches multiple
repos, emit one ticket per repo and use waves to express ordering — a
foundational change in repo A goes in wave 1, a consumer change in repo
B that depends on the wave-1 work goes in wave 2, etc.

Repo catalog:
${repoCatalog}

Most instructions are single-repo, single-ticket. Default to that shape
unless the instruction clearly spans repos. Do not invent cross-repo
work that the user did not ask for.

Return JSON matching this exact schema (no extra keys, no wrapping prose):
{
  "instruction": "<the original instruction, verbatim>",
  "waves": [
    {
      "wave": 1,
      "tickets": [
        {
          "id": "TKT-001",
          "repoName": "<one of the repo names from the catalog>",
          "title": "<short imperative title>",
          "description": "<what needs to happen and where, 2-5 sentences>",
          "acceptanceCriteria": ["<observable, testable criterion>", "<...>"],
          "rationale": "<why this ticket exists in this wave>"
        }
      ]
    }
  ]
}

Rules:
- Every ticket MUST include a "repoName" field whose value is one of the
  repo names listed above. Hallucinated or misspelled names are rejected.
- Wave 1 contains foundational work — shared types, migrations, interfaces,
  or core utilities that later waves depend on.
- Later waves (2, 3, ...) contain work that depends on the output of earlier
  waves. Use multiple waves ONLY when there is a real dependency that forces
  serialisation.
- Keep waves lean: if the instruction clearly has one foundation, put exactly
  ONE ticket in wave 1. At most 2-3 tickets per wave.
- For a simple single-task instruction, produce a single wave with a single
  ticket — do not invent scaffolding work.
- Ticket IDs MUST use the format TKT-001, TKT-002, ... numbered sequentially
  across all waves. They are placeholders that will be replaced by Linear
  issue IDs after creation.
- Every ticket MUST have at least one acceptanceCriteria entry.
- "instruction" MUST be the original user instruction, unchanged.

Respond with valid JSON only, no markdown.`;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    // Strip fenced code block (```json ... ``` or ``` ... ```)
    const withoutOpening = trimmed.replace(/^```(?:json)?\s*/i, '');
    const withoutClosing = withoutOpening.replace(/\s*```\s*$/i, '');
    return withoutClosing.trim();
  }
  return trimmed;
}

export async function generateWavePlan(instruction: string): Promise<WavePlan> {
  const trimmed = instruction.trim();
  if (!trimmed) {
    throw new Error('Instruction is empty');
  }

  const repoCatalog = formatRepoCatalog();
  const validRepoNames = new Set(Object.keys(getAllRepoConfigs()));
  const systemPrompt = buildSystemPrompt(repoCatalog);

  const raw = await callOpenAI(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Decompose this instruction into a WavePlan:\n\n${trimmed}`,
      },
    ],
    { jsonMode: true, maxTokens: 3000 }
  );

  if (!raw.trim()) {
    throw new Error('GPT-4.1 returned empty response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(
      `Failed to parse WavePlan JSON: ${(err as Error).message}\n--- raw response ---\n${raw}`
    );
  }

  const plan = assertWavePlan(parsed, validRepoNames);
  // Ensure the instruction is recorded verbatim regardless of model drift.
  plan.instruction = trimmed;
  return plan;
}
