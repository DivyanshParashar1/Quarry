import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildClaudeArgs, checkClaudeCli, createClaudeCodeProvider, parseClaudeResult } from './claude-code.js';
import { ProviderError } from './provider.js';

const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const req = {
  system: 'SYS',
  prompt: 'hello prompt',
  jsonSchema: { type: 'object', properties: { a: { type: 'string' } } },
  model: 'haiku',
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

describe('claude-code adapter', () => {
  it('builds the PLAN §5.2 command line (and never --bare)', () => {
    const args = buildClaudeArgs(req);
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(req.jsonSchema));
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('hello prompt'); // prompt goes on stdin
    expect(args).not.toContain('--allowedTools');
  });

  it('pre-approves only the web tools for web-search requests', () => {
    const args = buildClaudeArgs({ ...req, webSearch: true });
    expect(args.slice(args.indexOf('--allowedTools'))).toEqual(['--allowedTools', 'WebSearch,WebFetch']);
  });

  it('spawns the CLI with the prompt on stdin in an empty temp cwd', async () => {
    const p = createClaudeCodeProvider({ cliPath: FAKE_CLI, defaultModel: 'sonnet' });
    const res = await p.complete(req);
    const echo = (res.data as { echo: { stdin: string; cwd: string; schemaType: string } }).echo;
    expect(echo.stdin).toBe('hello prompt');
    expect(echo.schemaType).toBe('object');
    // The child reports its resolved cwd (macOS: /var -> /private/var).
    expect(echo.cwd.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(echo.cwd).toMatch(/jobforge-claude-/);
    expect(existsSync(echo.cwd)).toBe(false); // cleaned up
    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 30, totalTokens: 150, costUsd: 0.0123 });
    expect(res.model).toBe('resolved-haiku');
  });

  it('turns an is_error result into a ProviderError', async () => {
    const p = createClaudeCodeProvider({ cliPath: FAKE_CLI, defaultModel: 'sonnet' });
    await withEnv({ FAKE_CLAUDE_MODE: 'error' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/error_during_execution: rate limited/);
    });
  });

  it('reports a crash without JSON output', async () => {
    const p = createClaudeCodeProvider({ cliPath: FAKE_CLI, defaultModel: 'sonnet' });
    await withEnv({ FAKE_CLAUDE_MODE: 'crash' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/exited 3 without JSON output: boom/);
    });
  });

  it('kills the process on timeout', async () => {
    const p = createClaudeCodeProvider({ cliPath: FAKE_CLI, defaultModel: 'sonnet', timeoutMs: 300 });
    await withEnv({ FAKE_CLAUDE_MODE: 'hang' }, async () => {
      await expect(p.complete(req)).rejects.toThrow(/timed out after 300ms/);
    });
  });

  it('caps concurrency', async () => {
    let active = 0;
    let peak = 0;
    const p = createClaudeCodeProvider({
      defaultModel: 'sonnet',
      concurrency: 2,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { code: 0, stderr: '', stdout: JSON.stringify({ subtype: 'success', structured_output: {} }) };
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => p.complete(req)));
    expect(peak).toBe(2);
  });

  it('requires structured_output', () => {
    expect(() => parseClaudeResult({ code: 0, stderr: '', stdout: JSON.stringify({ subtype: 'success', result: 'hi' }) }, 'm')).toThrow(
      ProviderError,
    );
  });

  it('checkClaudeCli detects a missing CLI and a logged-out CLI', async () => {
    expect(await checkClaudeCli('/nonexistent/claude')).toMatchObject({ ok: false, problem: expect.stringMatching(/not found/) });
    expect(await checkClaudeCli(FAKE_CLI)).toEqual({ ok: true, version: '9.9.9 (Claude Code)', loggedIn: true });
    await withEnv({ FAKE_CLAUDE_LOGGED_IN: '0' }, async () => {
      expect(await checkClaudeCli(FAKE_CLI)).toMatchObject({ ok: false, loggedIn: false });
    });
  });
});
