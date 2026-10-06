// The same behavioural contract, run against every adapter with its transport
// faked: valid output passes through, invalid output gets one repair retry.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClaudeCodeProvider, type CliRunner } from './claude-code.js';
import { createLLMClient } from './client.js';
import { createFakeProvider } from './fake.js';
import { createOpenRouterProvider } from './openrouter.js';
import type { LLMProvider } from './provider.js';

const schema = z.object({ verdict: z.enum(['yes', 'no']), confidence: z.number().min(0).max(1) });
type Script = unknown[]; // successive model outputs

const adapters: Record<string, (script: Script) => LLMProvider> = {
  fake: (script) => createFakeProvider((_r, i) => script[Math.min(i, script.length - 1)]),
  'claude-code': (script) => {
    let i = 0;
    const run: CliRunner = async () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify({ subtype: 'success', is_error: false, structured_output: script[Math.min(i++, script.length - 1)] }),
    });
    return createClaudeCodeProvider({ defaultModel: 'sonnet', run });
  },
  openrouter: (script) => {
    let i = 0;
    const fetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(script[Math.min(i++, script.length - 1)]) } }] }),
      )) as unknown as typeof globalThis.fetch;
    return createOpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch });
  },
};

describe.each(Object.entries(adapters))('LLM contract: %s', (_name, make) => {
  const client = (script: Script) => createLLMClient({ providers: { 'claude-code': make(script) }, defaultProvider: 'claude-code' });

  it('returns validated structured output', async () => {
    const res = await client([{ verdict: 'yes', confidence: 0.9 }]).generate({ task: 'extract', system: 's', prompt: 'p', schema });
    expect(res.data).toEqual({ verdict: 'yes', confidence: 0.9 });
  });

  it('repairs once', async () => {
    const res = await client([{ verdict: 'maybe' }, { verdict: 'no', confidence: 0.2 }]).generate({
      task: 'extract',
      system: 's',
      prompt: 'p',
      schema,
    });
    expect(res.data.verdict).toBe('no');
  });

  it('gives up after the repair', async () => {
    await expect(
      client([{ verdict: 'maybe' }]).generate({ task: 'extract', system: 's', prompt: 'p', schema }),
    ).rejects.toThrow(/after repair/);
  });
});
