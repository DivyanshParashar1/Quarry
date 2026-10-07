import type { z } from 'zod';

// The LLM contract (PLAN.md §5.1). Lives here so plugins (via plugin-sdk) and
// @jobforge/llm share one definition without depending on each other.

/** research (Phase 10): web-search-backed estimates such as application deadlines. */
export const LLM_TASKS = ['match', 'tailor', 'outreach', 'extract', 'research'] as const;
export type LLMTask = (typeof LLM_TASKS)[number];

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
}

export interface LLMRequest<T> {
  task: LLMTask;
  system: string;
  prompt: string;
  /** Output schema; converted to JSON Schema for the provider and used to validate the reply. */
  schema: z.ZodType<T>;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Phase 10: let the model search the web. Providers that can't search answer
   * without it and report `webSearch.used = false`, so callers can lower their
   * confidence in the answer.
   */
  webSearch?: boolean;
}

export interface WebSearchInfo {
  /** True when the provider actually had a search tool for this call. */
  used: boolean;
  /** URLs the provider cited (from its own annotations, when it reports them). */
  citations: string[];
}

export interface LLMResponse<T> {
  data: T;
  usage: Usage;
  provider: string;
  model: string;
  /** Present when the request asked for web search. */
  webSearch?: WebSearchInfo;
}

export interface LLMClient {
  generate<T>(req: LLMRequest<T>): Promise<LLMResponse<T>>;
}

/** Local text embeddings. Vectors are L2-normalized, so dot product = cosine similarity. */
export interface Embedder {
  readonly dim: number;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
