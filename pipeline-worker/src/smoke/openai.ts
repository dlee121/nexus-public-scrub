import OpenAI from 'openai';

export async function smokeOpenAI(): Promise<void> {
  const client = new OpenAI({
    apiKey: process.env.GITHUB_TOKEN,
    baseURL: 'https://models.inference.ai.azure.com',
  });

  const resp = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'You are a code evaluator. Respond with valid JSON only.' },
      { role: 'user', content: 'Evaluate this trivial diff: +1 line added. Return: {"verdict":"pass","issues":[]}' },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 100,
  });

  const raw = resp.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw);
  if (!('verdict' in parsed)) throw new Error(`Response missing verdict field: ${raw}`);
}
