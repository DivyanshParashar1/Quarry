import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProvider } from './fake.js';
import { createLLMClient, LLMValidationError, type LLMCallRecord } from './client.js';
import { ProviderError } from './provider.js';

const schema = z.object({ score: z.number().int().min(0).max(100), reasons: z.string() });

describe('createLLMClient', () => {
  it('routes per task, validates, and reports the call', async () => {
    const a = createFakeProvider(() => ({ score: 80, reasons: 'good' }), { name: 'claude-code', defaultModel: 'sonnet' });
    const b = createFakeProvider(() => ({ score: 10, reasons: 'meh' }), { name: 'openrouter', defaultModel: 'x/y', costUsd: 0.01 });
    const calls: LLMCallRecord[] = [];
    const client = createLLMClient({
      providers: { 'claude-code': a, openrouter: b },
      defaultProvider: 'claude-code',
      tasks: { match: { provider: 'openrouter', model: 'cheap/model' }, tailor: { model: 'opus' } },
      onCall: (r) => void calls.push(r),
    });

    const m = await client.generate({ task: 'match', system: 's', prompt: 'p', schema });
    expect(m).toMatchObject({ data: { score: 10 }, provider: 'openrouter', model: 'cheap/model' });
    expect(b.calls[0]!.model).toBe('cheap/model');
    expect(b.calls[0]!.jsonSchema).toMatchObject({ type: 'object', required: ['score', 'reasons'] });

    const t = await client.generate({ task: 'tailor', system: 's', prompt: 'p', schema });
    expect(t).toMatchObject({ provider: 'claude-code', model: 'opus' });

    const e = await client.generate({ task: 'extract', system: 's', prompt: 'p', schema });
    expect(e).toMatchObject({ provider: 'claude-code', model: 'sonnet' });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ task: 'match', provider: 'openrouter', success: true, attempts: 1 });
    expect(calls[0]!.usage.costUsd).toBe(0.01);
  });

  it('runs exactly one repair retry with the validation errors', async () => {
    const p = createFakeProvider((_req, i) => (i === 0 ? { score: 'high' } : { score: 70, reasons: 'fixed' }));
    const calls: LLMCallRecord[] = [];
    const client = createLLMClient({ providers: { 'claude-code': p }, defaultProvider: 'claude-code', onCall: (r) => void calls.push(r) });
    const res = await client.generate({ task: 'match', system: 's', prompt: 'ORIGINAL', schema });
    expect(res.data).toEqual({ score: 70, reasons: 'fixed' });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1]!.prompt).toContain('ORIGINAL');
    expect(p.calls[1]!.prompt).toMatch(/score: Expected number/);
    expect(p.calls[1]!.prompt).toContain('"high"');
    expect(calls[0]).toMatchObject({ success: true, attempts: 2 });
    expect(calls[0]!.usage.promptTokens).toBe(p.calls.reduce((n, c) => n + Math.ceil((c.system.length + c.prompt.length) / 4), 0));
  });

  it('fails after a second invalid answer and records the failure', async () => {
    const p = createFakeProvider(() => ({ nope: true }));
    const calls: LLMCallRecord[] = [];
    const client = createLLMClient({ providers: { 'claude-code': p }, defaultProvider: 'claude-code', onCall: (r) => void calls.push(r) });
    await expect(client.generate({ task: 'match', system: 's', prompt: 'p', schema })).rejects.toBeInstanceOf(LLMValidationError);
    expect(p.calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ success: false, attempts: 2 });
    expect(calls[0]!.error).toMatch(/failed validation after repair/);
  });

  it('does not retry provider errors, but records them', async () => {
    const p = createFakeProvider(() => {
      throw new ProviderError('down', 'fake', true);
    });
    const calls: LLMCallRecord[] = [];
    const client = createLLMClient({ providers: { 'claude-code': p }, defaultProvider: 'claude-code', onCall: (r) => void calls.push(r) });
    await expect(client.generate({ task: 'match', system: 's', prompt: 'p', schema })).rejects.toThrow('down');
    expect(p.calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ success: false, attempts: 1, error: 'down' });
  });

  it('rejects a task routed to an unconfigured provider', async () => {
    const client = createLLMClient({
      providers: { 'claude-code': createFakeProvider(() => ({})) },
      defaultProvider: 'claude-code',
      tasks: { match: { provider: 'openrouter' } },
    });
    await expect(client.generate({ task: 'match', system: 's', prompt: 'p', schema })).rejects.toThrow(/not configured/);
  });

  it('a failing onCall sink never breaks the call', async () => {
    const client = createLLMClient({
      providers: { 'claude-code': createFakeProvider(() => ({ score: 1, reasons: 'r' })) },
      defaultProvider: 'claude-code',
      onCall: () => {
        throw new Error('db down');
      },
    });
    await expect(client.generate({ task: 'match', system: 's', prompt: 'p', schema })).resolves.toBeTruthy();
  });
});
