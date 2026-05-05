import { reviewPlan } from '../lib/openai';

export async function planReviewActivity(plan: string): Promise<string> {
  console.log('[planReview] Sending plan to GPT evaluator...');
  return reviewPlan(plan);
}
