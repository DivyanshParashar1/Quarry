import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  buildAntigravityArgs,
  checkAntigravityCli,
  createAntigravityProvider,
} from './antigravity.js';
import { createLLMClient } from './client.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agy.mjs', import.meta.url));
const req = {
  system: 'SYS',
  prompt: 'hello prompt',
  jsonSchema: { type: 'object', properties: { a: { type: 'string' } } },
  model: 'gemini-3-flash',
};

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

type Echo = { echo: { args: string[]; prompt: string; cwd: string; schemaType: string } };

describe('antigravity adapter', () => {
  it('builds a headless print-mode command line that never pre-approves tools', () => {
    const args = buildAntigravityArgs(req, 180_000);
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('SYS');
    expect(args[1]).toContain('hello prompt');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(req.jsonSchema));
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3-flash');
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('175s');
    expect(args).toContain('--sandbox');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(buildAntigravityArgs({ ...req, model: 'default' }, 180_000)).not.toContain('--model');
  });

  it('spawns agy in an empty temp cwd and reads structured_output and usage', async () => {
    const p = createAntigravityProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    const res = await p.complete(req);
    const echo = (res.data as Echo).echo;
    expect(echo.schemaType).toBe('object');
    expect(echo.cwd).toMatch(/quarry-agy-/);
    expect(existsSync(echo.cwd)).toBe(false);
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 40, totalTokens: 140 });
    expect(res.webSearch).toBeUndefined();
  });

  it('falls back to the response text when structured_output is missing', async () => {
    const p = createAntigravityProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    await withEnv({ FAKE_AGY_MODE: 'no-structured' }, async () => {
      expect((await p.complete(req)).data).toHaveProperty('echo.schemaType', 'object');
    });
  });

  it('reports web search as unused (no flag forces it)', async () => {
    const p = createAntigravityProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    expect((await p.complete({ ...req, webSearch: true })).webSearch).toEqual({
      used: false,
      citations: [],
    });
  });

  it('treats non-SUCCESS statuses and empty output as errors', async () => {
    const p = createAntigravityProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    await withEnv({ FAKE_AGY_MODE: 'waiting' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/WAITING.*never pre-approves/);
    });
    await withEnv({ FAKE_AGY_MODE: 'error' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/ERROR: unknown model/);
    });
    await withEnv({ FAKE_AGY_MODE: 'silent' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/without JSON output: \(empty\)/);
    });
  });

  it('kills the process on timeout', async () => {
    const p = createAntigravityProvider({
      cliPath: FAKE_CLI,
      defaultModel: 'default',
      timeoutMs: 300,
    });
    await withEnv({ FAKE_AGY_MODE: 'hang' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/antigravity timed out after 300ms/);
    });
  });

  it('checkAntigravityCli reports the version or a missing CLI', async () => {
    expect(await checkAntigravityCli(FAKE_CLI)).toEqual({ ok: true, version: 'agy 9.9.9' });
    expect(await checkAntigravityCli('/nonexistent/agy')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/ANTIGRAVITY_CLI_PATH/),
    });
  });

  it('ignores provider-less Claude/OpenAI pins but honours explicit ones', () => {
    const antigravity = createAntigravityProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    const client = createLLMClient({
      providers: { antigravity },
      defaultProvider: 'antigravity',
      tasks: {
        match: { model: 'claude-sonnet-4-6' },
        tailor: { model: 'gpt-5' },
        outreach: { model: 'gemini-3-pro' },
        extract: { provider: 'antigravity', model: 'claude-sonnet-4-6' },
      },
    });
    expect(client.route('match').model).toBe('default');
    expect(client.route('tailor').model).toBe('default');
    expect(client.route('outreach').model).toBe('gemini-3-pro');
    expect(client.route('extract').model).toBe('claude-sonnet-4-6');
  });
});
