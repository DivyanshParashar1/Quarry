import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderError, Semaphore, type LLMProvider, type ProviderRequest, type ProviderResponse } from './provider.js';

// Adapter A (PLAN.md §5.2): the user's locally installed, logged-in `claude`
// CLI in print mode. One spawn per request; personal, local use only.

export interface ClaudeCodeOptions {
  cliPath?: string;
  defaultModel: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Swappable for tests; defaults to spawning the real process. */
  run?: CliRunner;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CliRunner = (
  cliPath: string,
  args: string[],
  opts: { stdin?: string; cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<CliResult>;

/** The subset of `--output-format json` we read. Everything else passes through. */
const cliResultSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().nullable().optional(),
    structured_output: z.unknown().optional(),
    total_cost_usd: z.number().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
    modelUsage: z.record(z.unknown()).optional(),
  })
  .passthrough();

const STDIN_LIMIT = 10 * 1024 * 1024;

export function buildClaudeArgs(req: ProviderRequest): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.jsonSchema),
    '--model',
    req.model,
    '--system-prompt',
    req.system,
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--strict-mcp-config',
  ];
}

export function createClaudeCodeProvider(opts: ClaudeCodeOptions): LLMProvider {
  const cliPath = opts.cliPath ?? 'claude';
  const run = opts.run ?? spawnCli;
  const sem = new Semaphore(opts.concurrency ?? 2);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    name: 'claude-code',
    defaultModel: opts.defaultModel,
    complete: (req) =>
      sem.run(async (): Promise<ProviderResponse> => {
        if (Buffer.byteLength(req.prompt) > STDIN_LIMIT) {
          throw new ProviderError('prompt exceeds the 10MB stdin limit', 'claude-code');
        }
        // Empty cwd so no project CLAUDE.md, hooks, or .mcp.json are picked up.
        const cwd = await mkdtemp(join(tmpdir(), 'jobforge-claude-'));
        try {
          const res = await run(cliPath, buildClaudeArgs(req), {
            stdin: req.prompt,
            cwd,
            timeoutMs,
            ...(req.signal ? { signal: req.signal } : {}),
          });
          return parseClaudeResult(res, req.model);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }),
  };
}

export function parseClaudeResult(res: CliResult, requestedModel: string): ProviderResponse {
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    const detail = (res.stderr || res.stdout).trim().slice(0, 500);
    throw new ProviderError(`claude exited ${res.code} without JSON output: ${detail}`, 'claude-code', true);
  }
  const parsed = cliResultSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected claude JSON output shape', 'claude-code');
  const r = parsed.data;
  if (res.code !== 0 || r.is_error || (r.subtype && r.subtype !== 'success')) {
    const why = [r.subtype, r.result, res.stderr.trim()].filter(Boolean).join(': ').slice(0, 500);
    throw new ProviderError(`claude call failed (exit ${res.code}): ${why || 'unknown error'}`, 'claude-code', true);
  }
  if (r.structured_output === undefined) {
    throw new ProviderError('claude returned no structured_output (is --json-schema supported?)', 'claude-code');
  }
  const u = r.usage ?? {};
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completionTokens = u.output_tokens ?? 0;
  const models = Object.keys(r.modelUsage ?? {});
  return {
    data: r.structured_output,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(r.total_cost_usd !== undefined ? { costUsd: r.total_cost_usd } : {}),
    },
    model: models.length === 1 ? models[0]! : requestedModel,
  };
}

export const spawnCli: CliRunner = (cliPath, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new ProviderError(`claude timed out after ${opts.timeoutMs}ms`, 'claude-code', true)));
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(() => reject(new ProviderError('claude call aborted', 'claude-code')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new ProviderError(`claude CLI not found at "${cliPath}" (set CLAUDE_CLI_PATH)`, 'claude-code')
            : err,
        ),
      ),
    );
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => {
      /* the process may exit before reading stdin; reported via close */
    });
    child.stdin.end(opts.stdin ?? '');
  });

export interface ClaudeCliStatus {
  ok: boolean;
  version?: string;
  loggedIn?: boolean;
  problem?: string;
}

/**
 * Startup check: is the CLI installed and logged in? Uses `--version` and
 * `auth status`, neither of which makes a model call.
 */
export async function checkClaudeCli(cliPath = 'claude', run: CliRunner = spawnCli): Promise<ClaudeCliStatus> {
  const cwd = tmpdir();
  let version: string;
  try {
    const v = await run(cliPath, ['--version'], { cwd, timeoutMs: 15_000 });
    if (v.code !== 0) return { ok: false, problem: `"${cliPath} --version" exited ${v.code}: ${v.stderr.trim()}` };
    version = v.stdout.trim();
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  try {
    const a = await run(cliPath, ['auth', 'status'], { cwd, timeoutMs: 15_000 });
    const status = JSON.parse(a.stdout) as { loggedIn?: boolean };
    if (!status.loggedIn) return { ok: false, version, loggedIn: false, problem: 'claude CLI is not logged in; run `claude auth login`' };
    return { ok: true, version, loggedIn: true };
  } catch {
    // Older CLIs lack `auth status`; a failed call will surface auth problems instead.
    return { ok: true, version };
  }
}
