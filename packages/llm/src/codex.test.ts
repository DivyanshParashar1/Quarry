import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { checkCodexCli, createCodexProvider, parseCodexEvents } from './codex.js';
import { createLLMClient } from './client.js';
import { ProviderError } from './provider.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const req = {
  system: 'SYS',
  prompt: 'hello prompt',
  jsonSchema: {
    type: 'object',
    properties: { a: { type: 'string' }, opt: { type: 'string' } },
    required: ['a'],
    additionalProperties: false,
  },
  model: 'gpt-5-codex',
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

type Echo = {
  echo: { args: string[]; stdin: string; cwd: string; schema: Record<string, unknown> };
};

describe('codex adapter', () => {
  it('runs `codex exec` read-only and ephemeral, with the prompt on stdin and a strict schema file', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    const res = await p.complete(req);
    const { args, stdin, cwd, schema } = (res.data as Echo).echo;
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check']));
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5-codex');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('web_search="live"');
    expect(stdin).toContain('SYS');
    expect(stdin).toContain('hello prompt');
    expect(cwd).toMatch(/quarry-codex-/);
    expect(existsSync(cwd)).toBe(false);
    // Strict: every key required, the optional one nullable.
    expect(schema.required).toEqual(['a', 'opt']);
    expect((schema.properties as Record<string, unknown>).opt).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 35, totalTokens: 135 });
  });

  it('omits -m for the `default` model and asks for live search on web-search requests', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    const res = await p.complete({ ...req, model: 'default', webSearch: true });
    expect((res.data as Echo).echo.args).not.toContain('-m');
    expect((res.data as Echo).echo.args).toContain('web_search="live"');
    expect(res.webSearch).toEqual({ used: true, citations: [] });
  });

  it('turns strict-mode nulls back into missing optional keys', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    await withEnv({ FAKE_CODEX_MODE: 'nulls' }, async () => {
      expect((await p.complete(req)).data).toEqual({ a: 'x' });
    });
  });

  it('sends schemas strict mode cannot express without --output-schema', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    const open = { type: 'object', additionalProperties: { type: 'string' } };
    const res = await p.complete({ ...req, jsonSchema: open });
    expect((res.data as Echo).echo.args).not.toContain('--output-schema');
  });

  it('reads JSON from a fenced reply and from the -o file', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    for (const mode of ['fenced', 'file-only']) {
      await withEnv({ FAKE_CODEX_MODE: mode }, async () => {
        expect((await p.complete(req)).data).toHaveProperty('echo.stdin');
      });
    }
  });

  it('reports turn.failed as a ProviderError', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default' });
    await withEnv({ FAKE_CODEX_MODE: 'fail' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(
        /codex call failed \(exit 1\): usage limit reached/,
      );
    });
  });

  it('kills the process on timeout', async () => {
    const p = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'default', timeoutMs: 300 });
    await withEnv({ FAKE_CODEX_MODE: 'hang' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/codex timed out after 300ms/);
    });
  });

  it('rejects a reply without a message', () => {
    expect(() =>
      parseCodexEvents({ code: 0, stderr: '', stdout: '{"type":"turn.completed"}' }, 'm'),
    ).toThrow(ProviderError);
  });

  it('checkCodexCli detects a missing CLI and a logged-out CLI', async () => {
    expect(await checkCodexCli('/nonexistent/codex')).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/CODEX_CLI_PATH/),
    });
    expect(await checkCodexCli(FAKE_CLI)).toEqual({
      ok: true,
      version: 'codex-cli 9.9.9',
      loggedIn: true,
    });
    await withEnv({ FAKE_CODEX_LOGGED_IN: '0' }, async () => {
      expect(await checkCodexCli(FAKE_CLI)).toMatchObject({ ok: false, loggedIn: false });
    });
  });

  it('falls back to its default model when a provider-less config pin names a Claude model', () => {
    const codex = createCodexProvider({ cliPath: FAKE_CLI, defaultModel: 'gpt-5-codex' });
    const client = createLLMClient({
      providers: { codex },
      defaultProvider: 'codex',
      tasks: { match: { model: 'claude-sonnet-4-6' }, tailor: { model: 'gpt-5-mini' } },
    });
    expect(client.route('match').model).toBe('gpt-5-codex');
    expect(client.route('tailor').model).toBe('gpt-5-mini');
    expect(client.route('extract').model).toBe('gpt-5-codex');
  });
});
