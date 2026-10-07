import type { z } from 'zod';
import {
  LLMError,
  type LLMClient,
  type LLMProviderName,
  type LLMRequest,
  type LLMResponse,
  type LLMRouteOverride,
  type LLMTask,
  type Logger,
  type Usage,
} from '@jobforge/shared';
import { toJsonSchema } from './json-schema.js';
import { addUsage, emptyUsage, type LLMProvider, type ProviderResponse } from './provider.js';

/** One row per generate() call, written to `llm_calls` by the caller's sink. */
export interface LLMCallRecord {
  task: LLMTask;
  provider: string;
  model: string;
  success: boolean;
  /** 1, or 2 when a repair retry ran. */
  attempts: number;
  usage: Usage;
  latencyMs: number;
  error?: string;
}

export interface LLMClientOptions {
  providers: Partial<Record<LLMProviderName, LLMProvider>>;
  /** Provider used when a task has no override (LLM_PROVIDER). */
  defaultProvider: LLMProviderName;
  /** Per-task overrides from config.yaml. A model without a provider applies to the default provider. */
  tasks?: { [K in LLMTask]?: LLMRouteOverride | undefined };
  onCall?: (rec: LLMCallRecord) => void | Promise<void>;
  log?: Logger;
}

export class LLMValidationError extends LLMError {
  constructor(
    message: string,
    readonly issues: string,
  ) {
    super(message);
  }
}

export interface ResolvedRoute {
  provider: LLMProvider;
  model: string;
}

/**
 * The client the rest of the system uses. Routes each task to a provider and
 * model, validates output with zod, runs one repair retry on validation
 * failure, and reports every call. Callers never learn which provider is active.
 */
export function createLLMClient(opts: LLMClientOptions): LLMClient & { route(task: LLMTask): ResolvedRoute } {
  const route = (task: LLMTask): ResolvedRoute => {
    const o = opts.tasks?.[task];
    const name = o?.provider ?? opts.defaultProvider;
    const provider = opts.providers[name];
    if (!provider) throw new LLMError(`LLM provider "${name}" (task ${task}) is not configured`);
    return { provider, model: o?.model ?? provider.defaultModel };
  };

  async function generate<T>(req: LLMRequest<T>): Promise<LLMResponse<T>> {
    const { provider, model } = route(req.task);
    const jsonSchema = toJsonSchema(req.schema as z.ZodTypeAny);
    const started = Date.now();
    let usage = emptyUsage();
    let attempts = 0;
    let servedModel = model;
    let webSearch: { used: boolean; citations: string[] } | undefined;

    const call = async (prompt: string): Promise<ProviderResponse> => {
      attempts++;
      const res = await provider.complete({
        system: req.system,
        prompt,
        jsonSchema,
        model,
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.webSearch ? { webSearch: true } : {}),
      });
      if (req.webSearch) {
        const w = res.webSearch ?? { used: false, citations: [] };
        webSearch = { used: (webSearch?.used ?? false) || w.used, citations: [...new Set([...(webSearch?.citations ?? []), ...w.citations])] };
      }
      usage = addUsage(usage, res.usage);
      servedModel = res.model || model;
      return res;
    };

    const report = async (success: boolean, error?: string) => {
      const rec: LLMCallRecord = {
        task: req.task,
        provider: provider.name,
        model: servedModel,
        success,
        attempts,
        usage,
        latencyMs: Date.now() - started,
        ...(error ? { error } : {}),
      };
      try {
        await opts.onCall?.(rec);
      } catch (err) {
        opts.log?.warn({ err }, 'failed to record llm call');
      }
    };

    try {
      const first = await call(req.prompt);
      let parsed = req.schema.safeParse(first.data);
      if (!parsed.success) {
        const issues = formatIssues(parsed.error);
        opts.log?.debug({ task: req.task, issues }, 'llm output failed validation; repairing');
        const second = await call(repairPrompt(req.prompt, first.data, issues));
        parsed = req.schema.safeParse(second.data);
        if (!parsed.success) {
          throw new LLMValidationError(
            `${provider.name}/${model} output failed validation after repair: ${formatIssues(parsed.error)}`,
            formatIssues(parsed.error),
          );
        }
      }
      await report(true);
      return { data: parsed.data, usage, provider: provider.name, model: servedModel, ...(webSearch ? { webSearch } : {}) };
    } catch (err) {
      await report(false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return { generate, route };
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 20)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}

export function repairPrompt(original: string, previous: unknown, issues: string): string {
  const prev = previous === undefined ? '(no parseable JSON)' : JSON.stringify(previous).slice(0, 20_000);
  return [
    original,
    '',
    '---',
    'Your previous answer did not match the required JSON schema.',
    `Problems: ${issues}`,
    `Previous answer: ${prev}`,
    'Return the corrected JSON object only.',
  ].join('\n');
}
