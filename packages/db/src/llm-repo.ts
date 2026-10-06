import { sql } from 'drizzle-orm';
import type { DB } from './client.js';
import { llmCalls } from './schema.js';

export interface LlmCallRow {
  task: string;
  provider: string;
  model: string;
  success: boolean;
  attempts: number;
  usage: { promptTokens: number; completionTokens: number; costUsd?: number };
  latencyMs: number;
  error?: string;
  meta?: unknown;
}

/** One row per LLM generate() call. Never pass prompts or secrets in meta. */
export async function recordLlmCall(db: DB, r: LlmCallRow): Promise<void> {
  await db.insert(llmCalls).values({
    task: r.task,
    provider: r.provider,
    model: r.model,
    success: r.success,
    attempts: r.attempts,
    promptTokens: r.usage.promptTokens,
    completionTokens: r.usage.completionTokens,
    costUsd: r.usage.costUsd ?? null,
    latencyMs: r.latencyMs,
    error: r.error?.slice(0, 4000) ?? null,
    meta: r.meta ?? null,
  });
}

export async function llmUsageSummary(
  db: DB,
  since?: Date,
): Promise<{ calls: number; failed: number; costUsd: number; promptTokens: number; completionTokens: number }> {
  const [r] = await db.execute<{ calls: number; failed: number; cost: number; pt: number; ct: number }>(sql`
    select count(*)::int as calls,
           count(*) filter (where not success)::int as failed,
           coalesce(sum(cost_usd), 0)::float8 as cost,
           coalesce(sum(prompt_tokens), 0)::int as pt,
           coalesce(sum(completion_tokens), 0)::int as ct
    from ${llmCalls}
    where ${since ? sql`created_at >= ${since.toISOString()}::timestamptz` : sql`true`}`);
  return { calls: r!.calls, failed: r!.failed, costUsd: r!.cost, promptTokens: r!.pt, completionTokens: r!.ct };
}
