import type { LLMProvider, ProviderRequest } from './provider.js';

export interface FakeProvider extends LLMProvider {
  calls: ProviderRequest[];
}

/**
 * A provider that answers from a handler. Contract tests and stage tests run
 * against this; real providers only run in the manual smoke script.
 */
export function createFakeProvider(
  handler: (req: ProviderRequest, callIndex: number) => unknown,
  opts: { name?: string; defaultModel?: string; costUsd?: number } = {},
): FakeProvider {
  const calls: ProviderRequest[] = [];
  return {
    name: opts.name ?? 'fake',
    defaultModel: opts.defaultModel ?? 'fake-model',
    calls,
    async complete(req) {
      calls.push(req);
      const data = await handler(req, calls.length - 1);
      const promptTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
      const completionTokens = Math.ceil(JSON.stringify(data ?? null).length / 4);
      return {
        data,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
        },
        model: req.model,
      };
    },
  };
}
