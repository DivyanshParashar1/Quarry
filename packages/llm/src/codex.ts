import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { restoreOptional, toStrictSchema } from './strict-schema.js';

// Adapter C: the user's locally installed, logged-in OpenAI `codex` CLI in
// non-interactive mode (`codex exec`). One spawn per request, read-only
// sandbox, no session files; personal, local use only.

export interface CodexOptions {
  cliPath?: string;
  /** `default` leaves the model to the CLI's own config (~/.codex/config.toml). */
  defaultModel: string;
  concurrency?: number;
  timeoutMs?: number;
  run?: CliRunner;
}

const STDIN_LIMIT = 10 * 1024 * 1024;
const NAME = 'codex';

/** Models some other vendor serves; a provider-less config.yaml pin naming one falls back to CODEX_DEFAULT_MODEL. */
const FOREIGN_MODEL = /claude|sonnet|haiku|opus|gemini|^anthropic\/|^google\//i;

export function buildCodexArgs(
  req: Pick<ProviderRequest, 'model' | 'webSearch'>,
  paths: { cwd: string; schema?: string; lastMessage: string },
): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    paths.cwd,
    '-o',
    paths.lastMessage,
    ...(paths.schema ? ['--output-schema', paths.schema] : []),
    ...(req.model && req.model !== 'default' ? ['-m', req.model] : []),
    // Live search instead of the cached index (the flag form of --search).
    ...(req.webSearch ? ['-c', 'web_search="live"'] : []),
    '-', // prompt on stdin
  ];
}

export function createCodexProvider(opts: CodexOptions): LLMProvider {
  const cliPath = opts.cliPath ?? 'codex';
  const run = opts.run ?? spawnCli;
  const sem = new Semaphore(opts.concurrency ?? 2);
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return {
    name: NAME,
    defaultModel: opts.defaultModel,
    acceptsModel: (model) => !FOREIGN_MODEL.test(model),
    complete: (req) =>
      sem.run(async (): Promise<ProviderResponse> => {
        const prompt = inlineSystemPrompt(req.system, req.prompt);
        if (Buffer.byteLength(prompt) > STDIN_LIMIT)
          throw new ProviderError('prompt exceeds the 10MB stdin limit', NAME);
        // Empty cwd: no project AGENTS.md is picked up and the sandbox has nothing to read.
        const cwd = await mkdtemp(join(tmpdir(), 'quarry-codex-'));
        try {
          const strict = toStrictSchema(req.jsonSchema);
          const schemaPath = join(cwd, 'schema.json');
          // Schemas strict mode can't express go without --output-schema; the prompt and the client's repair retry cover them.
          if (strict) await writeFile(schemaPath, JSON.stringify(strict));
          const lastMessage = join(cwd, 'last-message.txt');
          const res = await run(
            cliPath,
            buildCodexArgs(req, { cwd, lastMessage, ...(strict ? { schema: schemaPath } : {}) }),
            {
              stdin: prompt,
              cwd,
              timeoutMs,
              provider: NAME,
              pathEnv: 'CODEX_CLI_PATH',
              ...(req.signal ? { signal: req.signal } : {}),
            },
          );
          const fallback = await readFile(lastMessage, 'utf8').catch(() => undefined);
          const out = parseCodexEvents(res, req.model, fallback);
          return { ...out, data: strict ? restoreOptional(out.data, req.jsonSchema) : out.data };
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }),
  };
}

interface CodexEvent {
  type?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; item_type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

/** Read the `codex exec --json` JSONL stream: the last agent message, usage, errors, web searches. */
export function parseCodexEvents(
  res: CliResult,
  requestedModel: string,
  lastMessageFile?: string,
): ProviderResponse {
  const events: CodexEvent[] = [];
  for (const line of res.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      events.push(JSON.parse(line) as CodexEvent);
    } catch {
      /* not an event line */
    }
  }
  const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
  if (failure || res.code !== 0) {
    const why = [failure?.error?.message ?? failure?.message, res.stderr.trim()]
      .filter(Boolean)
      .join(': ')
      .slice(0, 500);
    throw new ProviderError(
      `codex call failed (exit ${res.code}): ${why || 'unknown error'}`,
      NAME,
      true,
    );
  }
  const itemType = (e: CodexEvent) => e.item?.type ?? e.item?.item_type;
  const messages = events.filter(
    (e) =>
      e.type === 'item.completed' &&
      ['agent_message', 'assistant_message'].includes(itemType(e) ?? ''),
  );
  const text = messages.at(-1)?.item?.text ?? lastMessageFile;
  if (!text?.trim()) throw new ProviderError('codex returned no final message', NAME, true);
  const data = extractJson(text);
  if (data === undefined)
    throw new ProviderError(`codex reply was not JSON: ${text.trim().slice(0, 200)}`, NAME, true);

  // Usage is per turn; input_tokens already includes the cached part.
  let promptTokens = 0;
  let completionTokens = 0;
  for (const e of events) {
    if (e.type !== 'turn.completed' || !e.usage) continue;
    promptTokens += e.usage.input_tokens ?? 0;
    completionTokens += (e.usage.output_tokens ?? 0) + (e.usage.reasoning_output_tokens ?? 0);
  }
  const searched = events.some((e) => e.type === 'item.completed' && itemType(e) === 'web_search');
  return {
    data,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    model: requestedModel,
    webSearch: { used: searched, citations: [] },
  };
}

export interface CodexCliStatus {
  ok: boolean;
  version?: string;
  loggedIn?: boolean;
  problem?: string;
}

/** Startup check via `--version` and `login status` (exit 0 when logged in); neither makes a model call. */
export async function checkCodexCli(
  cliPath = 'codex',
  run: CliRunner = spawnCli,
): Promise<CodexCliStatus> {
  const cwd = tmpdir();
  const base = { cwd, timeoutMs: 15_000, provider: NAME, pathEnv: 'CODEX_CLI_PATH' };
  let version: string;
  try {
    const v = await run(cliPath, ['--version'], base);
    if (v.code !== 0)
      return { ok: false, problem: `"${cliPath} --version" exited ${v.code}: ${v.stderr.trim()}` };
    version = v.stdout.trim();
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
  const a = await run(cliPath, ['login', 'status'], base).catch(() => undefined);
  if (!a) return { ok: true, version };
  if (a.code !== 0)
    return {
      ok: false,
      version,
      loggedIn: false,
      problem: 'codex CLI is not logged in; run `codex login`',
    };
  return { ok: true, version, loggedIn: true };
}
