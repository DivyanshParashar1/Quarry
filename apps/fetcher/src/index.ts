#!/usr/bin/env -S node --import tsx/esm
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DomainRateLimiter, systemClock } from '@quarry/core/fetch';
import { configSchema as matcherConfigSchema } from '@quarry/matcher-default';
import { ATS_TYPES, createLogger, findUp, loadAppConfig, readPreferencesFile, type Logger } from '@quarry/shared';
import { listBatchFiles, readBatch } from './batch.js';
import { loadBoards, type Board } from './boards.js';
import { createSourceRegistry } from './registry.js';
import { fetchBoards, type BoardSummary } from './run.js';
import { readState, writeState } from './state.js';

const HELP = `quarry-fetcher — fetch job boards on an always-on device (phone/Termux) for the laptop to import

Usage:
  quarry-fetcher run [options]     fetch every board once (or forever with --every)
  quarry-fetcher status [--data]   what's waiting in the outbox

Options (run):
  --boards <file>        board list: boards.json from the laptop, or a companies CSV
                         (default: <data>/boards.json if present, else data/companies.seed.csv)
  --preferences <file>   preferences.yaml whose hard filters drop jobs before they're stored
                         (default: profile/preferences.yaml)
  --no-filter            keep every posting
  --data <dir>           where the outbox and state live (default: data/fetcher)
  --ats <type>           only boards on this ATS (${ATS_TYPES.join(', ')})
  --company <name>       only companies whose name contains this
  --concurrency <n>      boards fetched in parallel (default 4; per-domain rate limits still apply)
  --full                 resend every passing posting, not just new/changed ones
  --every <hours>        keep running, one pass every <hours>
  --verbose              log every board
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      boards: { type: 'string' },
      preferences: { type: 'string' },
      'no-filter': { type: 'boolean' },
      data: { type: 'string' },
      ats: { type: 'string' },
      company: { type: 'string' },
      concurrency: { type: 'string' },
      full: { type: 'boolean' },
      every: { type: 'string' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  const root = repoRoot();
  const dataDir = resolve(values.data ?? join(root, 'data', 'fetcher'));
  const outbox = join(dataDir, 'outbox');
  const statePath = join(dataDir, 'state.json');

  if (cmd === 'status') {
    printStatus(outbox, statePath);
    return 0;
  }
  if (cmd !== 'run') {
    console.error(`unknown command: ${cmd}\n\n${HELP}`);
    return 1;
  }

  if (values.ats && !(ATS_TYPES as readonly string[]).includes(values.ats)) {
    console.error(`--ats must be one of ${ATS_TYPES.join(', ')}`);
    return 1;
  }
  const everyHours = values.every !== undefined ? Number(values.every) : null;
  if (everyHours !== null && !(everyHours > 0)) {
    console.error('--every takes a number of hours > 0');
    return 1;
  }

  const log = createLogger({ level: process.env.LOG_LEVEL ?? (values.verbose ? 'info' : 'warn') });
  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort(new Error(sig)));

  const boardsPath = resolve(values.boards ?? (existsSync(join(dataDir, 'boards.json')) ? join(dataDir, 'boards.json') : join(root, 'data', 'companies.seed.csv')));
  const prefsPath = resolve(values.preferences ?? join(root, 'profile', 'preferences.yaml'));

  for (;;) {
    await runOnce({
      log,
      signal: stop.signal,
      boardsPath,
      prefsPath: values['no-filter'] ? null : prefsPath,
      outbox,
      statePath,
      filters: { ats: values.ats, company: values.company },
      concurrency: values.concurrency ? Number(values.concurrency) : 4,
      full: values.full === true,
    });
    if (everyHours === null || stop.signal.aborted) break;
    console.log(`next pass in ${everyHours}h (${new Date(Date.now() + everyHours * 3_600_000).toLocaleString()})`);
    await systemClock.sleep(everyHours * 3_600_000, stop.signal).catch(() => undefined);
    if (stop.signal.aborted) break;
  }
  return 0;
}

async function runOnce(o: {
  log: Logger;
  signal: AbortSignal;
  boardsPath: string;
  prefsPath: string | null;
  outbox: string;
  statePath: string;
  filters: { ats?: string | undefined; company?: string | undefined };
  concurrency: number;
  full: boolean;
}): Promise<void> {
  // Re-read everything each pass so a new boards.json or preferences.yaml applies without a restart.
  const config = loadAppConfig();
  const { boards: all, skipped } = loadBoards(o.boardsPath);
  if (skipped.length) o.log.info({ skipped }, `${skipped.length} board-list rows skipped`);
  const boards = all.filter((b) => matches(b, o.filters));
  if (!boards.length) {
    console.log(`No boards to fetch in ${o.boardsPath}.`);
    return;
  }
  const preferences = o.prefsPath ? readPreferencesFile(o.prefsPath) : null;
  const state = readState(o.statePath);

  const started = Date.now();
  const tty = process.stderr.isTTY;
  const results = await fetchBoards(
    {
      registry: createSourceRegistry(config),
      log: o.log,
      limiter: new DomainRateLimiter(),
      outbox: o.outbox,
      preferences,
      filterOptions: { experienceSlackYears: matcherConfigSchema.parse(config.plugins['matcher-default'] ?? {}).experienceSlackYears },
      full: o.full,
      signal: o.signal,
    },
    state,
    boards,
    { concurrency: o.concurrency, onProgress: (done, total) => tty && process.stderr.write(`\rfetching boards: ${done}/${total}`) },
  );
  if (tty) process.stderr.write('\n');
  writeState(o.statePath, state);
  printSummary(results, Date.now() - started, o.outbox);
}

function matches(b: Board, f: { ats?: string | undefined; company?: string | undefined }): boolean {
  if (f.ats && b.atsType !== f.ats) return false;
  if (f.company && !b.companyName.toLowerCase().includes(f.company.toLowerCase())) return false;
  return true;
}

function printSummary(results: BoardSummary[], ms: number, outbox: string): void {
  const failed = results.filter((r) => !r.ok);
  const sum = (k: 'postings' | 'filtered' | 'sent' | 'unchanged') => results.reduce((n, r) => n + r[k], 0);
  for (const r of failed) console.log(`FAILED  ${r.board.companyName} (${r.board.atsType}:${r.board.boardToken}): ${r.error}`);
  console.log(
    `${results.length} boards in ${Math.round(ms / 1000)}s: ${results.length - failed.length} ok, ${failed.length} failed. ` +
      `${sum('postings')} postings, ${sum('filtered')} filtered out, ${sum('sent')} new/changed, ${sum('unchanged')} unchanged.`,
  );
  console.log(`Batches in ${outbox}`);
}

function printStatus(outbox: string, statePath: string): void {
  const files = listBatchFiles(outbox);
  let postings = 0;
  let failed = 0;
  let unreadable = 0;
  for (const f of files) {
    try {
      const b = readBatch(f);
      postings += b.postings.length;
      if (!b.ok) failed++;
    } catch {
      unreadable++;
    }
  }
  const state = readState(statePath);
  console.log(`last run:  ${state.lastRunAt ?? 'never'}`);
  console.log(`boards:    ${Object.keys(state.boards).length} fetched at least once`);
  console.log(`outbox:    ${files.length} batches waiting (${postings} postings, ${failed} failed fetches${unreadable ? `, ${unreadable} unreadable` : ''})`);
}

function repoRoot(): string {
  const ws = findUp('pnpm-workspace.yaml');
  return ws ? dirname(ws) : process.cwd();
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
