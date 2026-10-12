import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spawnCli, type CliResult, type CliRunner } from './claude-code.js';
import {
  ProviderError,
  Semaphore,
  extractJson,
  inlineSystemPrompt,
  type LLMProvider,
  type ProviderRequest,
  type ProviderResponse,
} from './provider.js';

// Adapter D: Google's Antigravity CLI (`agy`), logged in interactively once,
// in headless print mode. One spawn per request; personal, local use only.
// Tools are never pre-approved: a run that wants one stops in WAITING, which
// is reported as an error rather than left to approve itself.

export interface AntigravityOptions {
  cliPath?: string;
  /** `default` leaves the model to the CLI (see `agy models`). */
  defaultModel: string;
  concurrency?: number;
  timeoutMs?: number;
  run?: CliRunner;
}

const NAME = 'antigravity';
/** Headless stdin needs the stream-json protocol, so the prompt goes in argv; stay well under macOS's 1MB ARG_MAX. */
const ARGV_LIMIT = 512 * 1024;

/** Anthropic-API and OpenAI model ids; Antigravity uses its own slugs, so a provider-less pin naming one falls back. */
const FOREIGN_MODEL =
  /^(claude-(haiku|sonnet|opus)-\d|haiku$|sonnet$|opus$|gpt-|o\d|anthropic\/|openai\/)/i;

const envelopeSchema = z
  .object({
    status: z.string().optional(),
    response: z.string().nullable().optional(),
    error: z.unknown().optional(),
    structured_output: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        thinking_tokens: z.number().optional(),
        cache_read_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function buildAntigravityArgs(req: ProviderRequest, timeoutMs: number): string[] {
  return [
    '-p',
    inlineSystemPrompt(req.system, req.prompt),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(req.jsonSchema),
    '--sandbox',
    // The CLI's own wait, a little under ours so it reports a status instead of being killed.
    '--print-timeout',
    `${Math.max(10, Math.floor(timeoutMs / 1000) - 5)}s`,
    ...(req.model && req.model !== 'default' ? ['--model', req.model] : []),
  ];
}

export function createAntigravityProvider(opts: AntigravityOptions): LLMProvider {
  const cliPath = opts.cliPath ?? 'agy';
  const run = opts.run ?? spawnCli;
  const sem = new Semaphore(opts.concurrency ?? 2);
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    name: NAME,
    defaultModel: opts.defaultModel,
    acceptsModel: (model) => !FOREIGN_MODEL.test(model),
    complete: (req) =>
      sem.run(async (): Promise<ProviderResponse> => {
        const args = buildAntigravityArgs(req, timeoutMs);
        if (Buffer.byteLength(args[1]!) > ARGV_LIMIT)
          throw new ProviderError('prompt exceeds the 512KB argv limit', NAME);
        // Empty cwd so no project rules or workspace files are picked up.
        const cwd = await mkdtemp(join(tmpdir(), 'quarry-agy-'));
        try {
          const res = await run(cliPath, args, {
            cwd,
            timeoutMs,
            provider: NAME,
            pathEnv: 'ANTIGRAVITY_CLI_PATH',
            ...(req.signal ? { signal: req.signal } : {}),
          });
          const out = parseAntigravityResult(res, req.model);
          // No headless flag forces a search and the envelope doesn't list tool calls; callers lower confidence.
          return req.webSearch ? { ...out, webSearch: { used: false, citations: [] } } : out;
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }),
  };
}

export function parseAntigravityResult(res: CliResult, requestedModel: string): ProviderResponse {
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    // Some builds print nothing when stdout isn't a TTY (agy issue #76).
    const detail = (res.stderr || res.stdout).trim().slice(0, 500);
    throw new ProviderError(
      `agy exited ${res.code} without JSON output: ${detail || '(empty)'}`,
      NAME,
      true,
    );
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) throw new ProviderError('unexpected agy JSON output shape', NAME);
  const r = parsed.data;
  if (r.status !== 'SUCCESS') {
    const err = typeof r.error === 'string' ? r.error : r.error ? JSON.stringify(r.error) : '';
    const hint =
      r.status === 'WAITING'
        ? 'the model asked to use a tool, which Quarry never pre-approves'
        : '';
    const why = [r.status ?? `exit ${res.code}`, err, hint, res.stderr.trim()]
      .filter(Boolean)
      .join(': ')
      .slice(0, 500);
    throw new ProviderError(`agy call failed: ${why}`, NAME, r.status !== 'INVALID');
  }
  // Some builds report SUCCESS with structured_output missing (agy issue #1065); the text usually still has the JSON.
  const data = r.structured_output ?? (r.response ? extractJson(r.response) : undefined);
  if (data === undefined)
    throw new ProviderError(
      'agy returned no structured_output and no JSON in its response',
      NAME,
      true,
    );
  const u = r.usage ?? {};
  const promptTokens = u.input_tokens ?? 0;
  const completionTokens = (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
  return {
    data,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: u.total_tokens ?? promptTokens + completionTokens,
    },
    model: requestedModel,
  };
}

export interface AntigravityCliStatus {
  ok: boolean;
  version?: string;
  problem?: string;
}

/** Startup check via `--version` only: agy has no scriptable auth check, so a logged-out CLI surfaces on the first call. */
export async function checkAntigravityCli(
  cliPath = 'agy',
  run: CliRunner = spawnCli,
): Promise<AntigravityCliStatus> {
  try {
    const v = await run(cliPath, ['--version'], {
      cwd: tmpdir(),
      timeoutMs: 15_000,
      provider: NAME,
      pathEnv: 'ANTIGRAVITY_CLI_PATH',
    });
    if (v.code !== 0)
      return { ok: false, problem: `"${cliPath} --version" exited ${v.code}: ${v.stderr.trim()}` };
    return { ok: true, version: v.stdout.trim() };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}
