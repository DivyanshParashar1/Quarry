// LLM provider interface + adapters — implemented in Phase 2.
// Interface shape pinned here so dependents can import stable types.

import type { z } from 'zod';

export type LLMTask = 'match' | 'tailor' | 'outreach' | 'extract';

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface LLMResponse<T> {
  data: T;
  usage: Usage;
  provider: string;
  model: string;
}

export interface LLMRequest<T> {
  task: LLMTask;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface LLMClient {
  generate<T>(req: LLMRequest<T>): Promise<LLMResponse<T>>;
}
