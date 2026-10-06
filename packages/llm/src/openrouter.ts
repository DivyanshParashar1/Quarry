import { z } from 'zod';
import { ProviderError, Semaphore, extractJson, type LLMProvider, type ProviderResponse } from './provider.js';

// Adapter B (PLAN.md §5.3): OpenRouter's OpenAI-compatible chat completions API.

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
  concurrency?: number;
  timeoutMs?: number;
  /**
   * `auto` (default): request json_schema output and fall back to JSON-only
   * prompting for models whose providers reject it. `prompt`: always prompt.
   */
  structuredOutputs?: 'auto' | 'prompt';
  fetch?: typeof globalThis.fetch;
}

const completionSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).passthrough() }).passthrough())
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
        cost: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function createOpenRouterProvider(opts: OpenRouterOptions): LLMProvider {
  if (!opts.apiKey) throw new ProviderError('OPENROUTER_API_KEY is not set', 'openrouter');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const sem = new Semaphore(opts.concurrency ?? 4);
  const timeoutMs = opts.timeoutMs ?? 120_000;
  // Models whose providers rejected response_format this process; prompt them instead.
  const promptOnly = new Set<string>();

  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        'x-title': 'JobForge',
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  };

  return {
    name: 'openrouter',
    defaultModel: opts.defaultModel,
    complete: (req) =>
      sem.run(async (): Promise<ProviderResponse> => {
        const base = {
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          usage: { include: true },
        };
        const useSchema = opts.structuredOutputs !== 'prompt' && !promptOnly.has(req.model);
        let res: Response;
        if (useSchema) {
          res = await post(
            {
              ...base,
              messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.prompt },
              ],
              response_format: { type: 'json_schema', json_schema: { name: 'output', strict: false, schema: req.jsonSchema } },
              // Only route to providers that honour response_format.
              provider: { require_parameters: true },
            },
            req.signal,
          );
          if (res.status === 400 || res.status === 404) {
            promptOnly.add(req.model);
            res = await post({ ...base, messages: promptMessages(req.system, req.prompt, req.jsonSchema) }, req.signal);
          }
        } else {
          res = await post({ ...base, messages: promptMessages(req.system, req.prompt, req.jsonSchema) }, req.signal);
        }

        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 500);
          throw new ProviderError(`openrouter ${res.status}: ${text}`, 'openrouter', res.status === 429 || res.status >= 500);
        }
        const parsed = completionSchema.safeParse(await res.json());
        if (!parsed.success) throw new ProviderError('unexpected openrouter response shape', 'openrouter');
        const c = parsed.data;
        const content = c.choices[0]!.message.content ?? '';
        const u = c.usage ?? {};
        const promptTokens = u.prompt_tokens ?? 0;
        const completionTokens = u.completion_tokens ?? 0;
        return {
          // Unparseable text becomes `undefined`, which fails validation and triggers the client's repair retry.
          data: extractJson(content),
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: u.total_tokens ?? promptTokens + completionTokens,
            ...(u.cost !== undefined ? { costUsd: u.cost } : {}),
          },
          model: c.model ?? req.model,
        };
      }),
  };
}

function promptMessages(system: string, prompt: string, schema: Record<string, unknown>) {
  return [
    {
      role: 'system',
      content: `${system}\n\nRespond with a single JSON object that conforms to this JSON Schema. No prose, no code fences.\n${JSON.stringify(schema)}`,
    },
    { role: 'user', content: prompt },
  ];
}
