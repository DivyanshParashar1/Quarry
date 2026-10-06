#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, loadEnv } from '@jobforge/shared';
import { countJobs, createDb, listJobs, listSourceTargets, type AtsType } from '@jobforge/db';
import {
  DomainRateLimiter,
  enqueueSourceFetches,
  QUEUES,
  registerSourceWorker,
  SOURCE_PLUGIN_FOR_ATS,
  startBoss,
  waitForJobs,
  type SourceRunSummary,
} from '@jobforge/core';
import { importCompanies, parseCompaniesCsv } from './companies.js';
import { fmtDate, table } from './format.js';
import { createRegistry } from './plugins.js';

const HELP = `jf — JobForge CLI

Usage:
  jf companies import <file.csv> [--skip-invalid]
      CSV header: name,ats_type,board_token[,domain,tags,location,notes]
      tags are ';'-separated. Re-importing is idempotent.
  jf companies list
  jf fetch [--plugin <id>] [--company <name>] [--concurrency <n>] [--verbose]
      Fetch every active board (or a subset) through the job queue.
  jf jobs list [--company <name>] [--q <title text>] [--limit <n>] [--all]
      --all includes closed jobs.
`;

/** Load the nearest .env above cwd into process.env (existing vars win). */
function loadDotEnv(): void {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const f = join(dir, '.env');
    if (existsSync(f)) {
      process.loadEnvFile(f);
      return;
    }
    if (dirname(dir) === dir) return;
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      plugin: { type: 'string' },
      company: { type: 'string' },
      concurrency: { type: 'string' },
      q: { type: 'string' },
      limit: { type: 'string' },
      all: { type: 'boolean' },
      'skip-invalid': { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, sub, arg] = positionals;
  if (!cmd || values.help || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  loadDotEnv();
  const env = loadEnv();
  const log = createLogger({ level: values.verbose ? 'debug' : 'warn' });
  const { db, close } = createDb(env.DATABASE_URL, 8);

  try {
    if (cmd === 'companies' && sub === 'import') {
      if (!arg) throw new UsageError('missing <file.csv>');
      const { rows, errors } = parseCompaniesCsv(readFileSync(resolve(arg), 'utf8'));
      if (errors.length) {
        process.stderr.write(`${errors.length} invalid row(s):\n  ${errors.join('\n  ')}\n`);
        if (!values['skip-invalid']) {
          process.stderr.write('Nothing imported. Fix the rows or pass --skip-invalid.\n');
          return 1;
        }
      }
      const r = await importCompanies(db, rows);
      console.log(
        `companies: ${r.companiesCreated} created, ${r.companiesUpdated} updated; ` +
          `sources: ${r.sourcesCreated} created, ${r.sourcesExisting} already present`,
      );
      return 0;
    }

    if (cmd === 'companies' && sub === 'list') {
      const rows = await listSourceTargets(db, { includePaused: true });
      console.log(
        table(rows, [
          { header: 'COMPANY', value: (r) => r.companyName },
          { header: 'ATS', value: (r) => r.atsType },
          { header: 'BOARD', value: (r) => r.boardToken },
          { header: 'STATUS', value: (r) => r.status },
        ]),
      );
      return 0;
    }

    if (cmd === 'fetch') return await fetchCommand(values, db, env.DATABASE_URL, env.MODE, log);

    if (cmd === 'jobs' && sub === 'list') {
      const rows = await listJobs(db, {
        ...(values.company ? { company: values.company } : {}),
        ...(values.q ? { q: values.q } : {}),
        includeClosed: !!values.all,
        limit: values.limit ? Number(values.limit) : 50,
      });
      console.log(
        table(rows, [
          { header: 'COMPANY', value: (r) => r.company, max: 20 },
          { header: 'TITLE', value: (r) => r.title, max: 55 },
          { header: 'LOCATION', value: (r) => r.locations.join('; '), max: 30 },
          { header: 'REMOTE', value: (r) => r.remotePolicy ?? '' },
          { header: 'LEVEL', value: (r) => r.seniority ?? '' },
          { header: 'POSTED', value: (r) => fmtDate(r.postedAt) },
          { header: 'SRC', value: (r) => String(r.sources) },
          ...(values.all ? [{ header: 'CLOSED', value: (r: (typeof rows)[number]) => fmtDate(r.closedAt) }] : []),
          { header: 'ID', value: (r) => r.id.slice(0, 8) },
        ]),
      );
      const c = await countJobs(db);
      console.log(`\n${rows.length} shown · ${c.open} open · ${c.closed} closed · ${c.rawPostings} raw postings`);
      return 0;
    }

    throw new UsageError(`unknown command: ${positionals.join(' ')}`);
  } finally {
    await close();
  }
}

async function fetchCommand(
  values: { plugin?: string | undefined; company?: string | undefined; concurrency?: string | undefined },
  db: ReturnType<typeof createDb>['db'],
  databaseUrl: string,
  mode: 'dev' | 'live',
  log: ReturnType<typeof createLogger>,
): Promise<number> {
  const registry = createRegistry();
  let atsTypes: AtsType[] | undefined;
  if (values.plugin) {
    registry.source(values.plugin); // throws on unknown id
    atsTypes = (Object.entries(SOURCE_PLUGIN_FOR_ATS) as [AtsType, string][])
      .filter(([, id]) => id === values.plugin)
      .map(([ats]) => ats);
  }
  const targets = (
    await listSourceTargets(db, { ...(atsTypes ? { atsTypes } : {}), ...(values.company ? { companyName: values.company } : {}) })
  ).filter((t) => SOURCE_PLUGIN_FOR_ATS[t.atsType]);
  if (!targets.length) {
    console.log('No matching boards. Import some with `jf companies import <csv>`.');
    return 0;
  }

  const boss = await startBoss(databaseUrl);
  try {
    await registerSourceWorker(
      boss,
      { db, registry, log, limiter: new DomainRateLimiter(), dryRun: mode !== 'live' },
      { concurrency: values.concurrency ? Number(values.concurrency) : 4 },
    );
    const ids = await enqueueSourceFetches(
      boss,
      targets.map((t) => t.companySourceId),
    );
    const tty = process.stderr.isTTY;
    const results = await waitForJobs(boss, QUEUES.sourceFetch, ids, {
      onProgress: (done, total) => tty && process.stderr.write(`\rfetching boards: ${done}/${total}`),
    });
    if (tty) process.stderr.write('\n');

    const rows = ids.map((id, i) => {
      const r = results.get(id)!;
      const t = targets[i]!;
      if (r.state === 'completed') return r.output as SourceRunSummary;
      const out = r.output as { message?: string } | null;
      return {
        ok: false,
        companyName: t.companyName,
        boardToken: t.boardToken,
        pluginId: SOURCE_PLUGIN_FOR_ATS[t.atsType]!,
        postings: 0,
        invalid: 0,
        jobsCreated: 0,
        jobsUpdated: 0,
        jobsClosed: 0,
        error: out?.message ?? r.state,
      } satisfies SourceRunSummary;
    });
    console.log(
      table(rows, [
        { header: 'COMPANY', value: (r) => r.companyName, max: 24 },
        { header: 'PLUGIN', value: (r) => r.pluginId },
        { header: 'RESULT', value: (r) => (r.ok ? 'ok' : 'FAILED') },
        { header: 'POSTINGS', value: (r) => String(r.postings) },
        { header: 'NEW', value: (r) => String(r.jobsCreated) },
        { header: 'SEEN', value: (r) => String(r.jobsUpdated) },
        { header: 'CLOSED', value: (r) => String(r.jobsClosed) },
        { header: 'ERROR', value: (r) => r.error ?? '', max: 50 },
      ]),
    );
    const ok = rows.filter((r) => r.ok).length;
    const sum = (k: 'postings' | 'jobsCreated' | 'jobsClosed') => rows.reduce((a, r) => a + r[k], 0);
    const c = await countJobs(db);
    console.log(
      `\n${ok}/${rows.length} boards ok · ${sum('postings')} postings · ${sum('jobsCreated')} new jobs · ` +
        `${sum('jobsClosed')} closed · ${c.open} open jobs total`,
    );
    return ok === 0 ? 1 : 0;
  } finally {
    await boss.stop({ graceful: true, timeout: 10_000 });
  }
}

class UsageError extends Error {}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${HELP}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
