import type { Usage } from '@jobforge/shared';

/** What an adapter receives: already-routed, schema already converted. */
export interface ProviderRequest {
  system: string;
  prompt: string;
  /** JSON Schema (draft-07) for the output object. */
  jsonSchema: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Give the model a web-search tool (Phase 10). */
  webSearch?: boolean;
}

export interface ProviderResponse {
  /** Parsed JSON; validated against the zod schema by the client, not the adapter. */
  data: unknown;
  usage: Usage;
  /** The model that actually served the request, when the provider reports it. */
  model: string;
  /** Whether a search tool was available, and what it cited (webSearch requests only). */
  webSearch?: { used: boolean; citations: string[] };
}

export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}

/** Thrown by adapters. `retryable` is a hint only; the client does not retry transport errors. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export const emptyUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return out;
}

/** FIFO concurrency cap. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/**
 * Pull a JSON object out of model text: bare JSON, a ```json fence, or the
 * outermost {...} span. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const candidates = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try the next shape */
    }
  }
  return undefined;
}
