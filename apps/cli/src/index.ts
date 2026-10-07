#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, findUp, loadAppConfig, loadEnv, type AppConfig, type Env } from '@jobforge/shared';
import {
  countJobs,
  createDb,
  listCompaniesForAtsCheck,
  getActiveProfile,
  listRankedJobs,
  listSourceTargets,
  llmUsageSummary,
  matchStats,
  resolveIdPrefix,
  type AtsType,
} from '@jobforge/db';
import {
  checkLatex,
  COMPANY_LISTS,
  createPageFetcher,
  discoverAndSave,
  discoverAts,
  DomainRateLimiter,
  normalizeDomain,
  runDiscoverCompanies,
  type DiscoverAtsResult,
  embedPending,
  enqueueSourceFetches,
  loadProfile,
  QUEUES,
  registerSourceWorker,
  runAutopilot,
  runMatch,
  runTailor,
  SOURCE_PLUGIN_FOR_ATS,
  startBoss,
  waitForJobs,
  type SourceRunSummary,
} from '@jobforge/core';
import { checkClaudeCli } from '@jobforge/llm';
import { importCompanies, parseCompaniesCsv } from './companies.js';
import { fmtDate, table } from './format.js';
import { createRegistry } from './plugins.js';
import { createEmbedder, createGmail, createLLM, outreachDeps, tailorDeps } from './runtime.js';
import { CmdError, contactsCommand, outreachCommand, reviewCommand } from './outreach-cmds.js';
import { gmailAuth } from './gmail-auth.js';

const HELP = `jf — JobForge CLI

Usage:
  jf companies import <file.csv> [--skip-invalid]
      CSV header: name,ats_type,board_token[,domain,tags,location,notes]
      tags are ';'-separated. Re-importing is idempotent.
  jf companies list
  jf fetch [--plugin <id>] [--company <name>] [--concurrency <n>] [--verbose]
      Fetch every active board (or a subset) through the job queue.
  jf discover_ats <domain|company name> [--name <company>] [--save] [--no-probe]
      Detect a company's ATS from its careers pages (robots.txt respected), falling
      back to ATS API probes by name. --save writes the company + detected boards.
  jf discover_ats --missing [--limit <n>]
      Run detection for companies that have no board yet (e.g. seeded with a domain only).
  jf discover_companies --list <yc|gcc-journal|wellfound|internshala|hirect> [--max-new <n>] [--dry-run] [--concurrency <n>]
      Crawl a public company list, detect each new company's ATS, save company + boards.
  jf jobs list [--company <name>] [--q <title text>] [--limit <n>] [--all]
      Sorted by match score once \`jf match\` has run. --all includes closed jobs.
  jf profile load [--dir <profile dir>]
      Validate profile/facts.yaml + preferences.yaml and make them the active profile.
  jf profile show
  jf embed
      Embed new/changed jobs, facts, and the profile (local model; downloads once).
  jf match [--rescore] [--limit <n>] [--no-embed]
      Score open jobs against the active profile: hard filters, similarity
      prefilter, then the LLM rubric. Already-scored jobs are skipped unless --rescore.
  jf tailor <jobId>
      Produce a grounded, one-page tailored resume PDF (Jake's resume LaTeX template).
      Every bullet traces to a profile fact; invented numbers/terms are dropped.
      Requires \`latexmk\` (TeX Live) on PATH.
  jf autopilot [--limit <n>] [--live]
      LLM-in-the-loop: walk top-ranked jobs, tailor + draft, auto-approve the
      high-confidence ones. Low-confidence items are left pending in the review
      queue. Dry run by default; --live writes decisions and lets the send loop
      pick them up (per MODE=live).
  jf llm check
      Show the provider/model per task and check the provider is reachable (no model call).

Outreach (nothing is sent without an approved review item; dry run unless --live or MODE=live):
  jf gmail auth | status         Connect your Gmail (OAuth, local) / show the connected account.
  jf contacts add --company <name> --name <full name> [--role] [--email] [--linkedin] [--domain]
  jf contacts list [--company <name>]
  jf contacts enrich [--company <name>]    Infer emails from the company pattern (MX-checked).
  jf outreach draft --contact <id> [--job <id>] [--force]
      LLM-draft an email into the review queue.
  jf review list [--all] | show <id> | edit <id> [--subject] [--to] [--body-file <path>]
  jf review approve <id> [--override-company-cap] | reject <id> [--reason <text>]
  jf outreach send [--live] [--watch]
      Send approved emails (one per run; --watch keeps going, respecting caps and spacing).
  jf outreach followups           Draft due follow-ups for review.
  jf outreach track               Check Gmail for replies and bounces.
  jf outreach threads
Ids can be shortened to their first 8 characters.
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
      dir: { type: 'string' },
      rescore: { type: 'boolean' },
      'no-embed': { type: 'boolean' },
      name: { type: 'string' },
      role: { type: 'string' },
      email: { type: 'string' },
      linkedin: { type: 'string' },
      domain: { type: 'string' },
      contact: { type: 'string' },
      job: { type: 'string' },
      subject: { type: 'string' },
      'body-file': { type: 'string' },
      to: { type: 'string' },
      reason: { type: 'string' },
      'override-company-cap': { type: 'boolean' },
      live: { type: 'boolean' },
      watch: { type: 'boolean' },
      force: { type: 'boolean' },
      list: { type: 'string' },
      'max-new': { type: 'string' },
      'dry-run': { type: 'boolean' },
      save: { type: 'boolean' },
      missing: { type: 'boolean' },
      'no-probe': { type: 'boolean' },
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
  const config = loadAppConfig();
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

    if (cmd === 'discover_ats' || (cmd === 'discover' && sub === 'ats')) {
      const target = cmd === 'discover' ? arg : sub;
      return await discoverAtsCommand(target, values, db, log, config);
    }
    if (cmd === 'discover_companies' || (cmd === 'discover' && sub === 'companies')) {
      return await discoverCompaniesCommand(values, env, config, db, log);
    }

    if (cmd === 'fetch') return await fetchCommand(values, db, env.DATABASE_URL, env.MODE, log, config);

    if (cmd === 'profile' && sub === 'load') {
      const dir = resolve(values.dir ?? profileDir());
      const r = await loadProfile(db, dir);
      console.log(
        `profile ${r.version} ${r.snapshotCreated ? 'loaded (new version)' : 'unchanged'} · facts: ` +
          `${r.factsCreated} new, ${r.factsUpdated} updated, ${r.factsUnchanged} unchanged, ${r.factsRetired} retired`,
      );
      const p = await getActiveProfile(db);
      if (p && !p.facts.length && !p.preferences.roles.length) {
        console.log('Warning: profile has no facts and no roles; fill in profile/*.yaml before matching.');
      } else if (r.snapshotCreated) console.log('Next: `jf match` scores jobs against this version.');
      return 0;
    }

    if (cmd === 'profile' && sub === 'show') {
      const p = await getActiveProfile(db);
      if (!p) {
        console.log('No profile loaded. Fill in profile/*.yaml and run `jf profile load`.');
        return 1;
      }
      console.log(`version ${p.version} · ${p.facts.length} facts · embedded: ${p.embedding ? 'yes' : 'no'}\n`);
      console.log(p.summary);
      return 0;
    }

    if (cmd === 'embed') {
      const s = await runEmbed(db, config, log);
      console.log(`embedded ${s.jobs} jobs, ${s.facts} facts${s.profile ? ', and the profile' : ''}`);
      return 0;
    }

    if (cmd === 'match') {
      if (!values['no-embed']) {
        const s = await runEmbed(db, config, log);
        if (s.jobs || s.facts || s.profile) console.log(`embedded ${s.jobs} jobs, ${s.facts} facts${s.profile ? ', profile' : ''}`);
      }
      const llm = createLLM(env, config, db, log);
      const route = llm.route('match');
      console.log(`matching with ${route.provider.name}/${route.model} …`);
      const before = await llmUsageSummary(db);
      const started = Date.now();
      const s = await runMatch(
        { db, registry: createRegistry(config), log, llm, limiter: new DomainRateLimiter(), dryRun: env.MODE !== 'live' },
        { ...(values.rescore ? { rescore: true } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) },
      );
      const after = await llmUsageSummary(db);
      console.log(
        `${s.candidates} candidates · ${s.llm} LLM-scored · ${s.prefilter} below prefilter · ${s.filtered} filtered · ` +
          `${s.unscored} left for next run · ${after.calls - before.calls} LLM calls ` +
          `(${after.failed - before.failed} failed, $${(after.costUsd - before.costUsd).toFixed(4)}) · ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      return s.candidates && !s.llm && !s.prefilter && !s.filtered ? 1 : 0;
    }

    if (cmd === 'tailor') {
      if (!sub) throw new UsageError('missing <jobId>');
      return await tailorCommand(sub, env, config, db, log);
    }

    if (cmd === 'autopilot') return await autopilotCommand(values, env, config, db, log);

    if (cmd === 'llm' && sub === 'check') return await llmCheck(env, config, db, log);

    const cmdCtx = { env, config, db, log, out: (s: string) => console.log(s) };
    if (cmd === 'contacts') return await contactsCommand(sub, values, cmdCtx);
    if (cmd === 'review') return await reviewCommand(sub, arg, values, cmdCtx);
    if (cmd === 'outreach') return await outreachCommand(sub, values, cmdCtx);
    if (cmd === 'gmail' && sub === 'auth') {
      const envPath = findUp('.env') ?? resolve('.env');
      const address = await gmailAuth(env, envPath, (s) => console.log(s));
      console.log(`Connected ${address}. Token saved to ${envPath} (mode 600).`);
      return 0;
    }
    if (cmd === 'gmail' && sub === 'status') {
      const gmail = await createGmail(env, new DomainRateLimiter());
      console.log(gmail ? `connected: ${gmail.address} · mode ${env.MODE}` : 'Gmail not connected. Run `jf gmail auth`.');
      return gmail ? 0 : 1;
    }

    if (cmd === 'jobs' && sub === 'list') {
      const profile = await getActiveProfile(db);
      const { rows } = await listRankedJobs(db, {
        profileVersion: profile?.version ?? null,
        ...(values.company ? { company: values.company } : {}),
        ...(values.q ? { q: values.q } : {}),
        includeClosed: !!values.all,
        sort: profile ? 'score' : 'posted',
        limit: values.limit ? Number(values.limit) : 50,
      });
      console.log(
        table(rows, [
          ...(profile ? [{ header: 'SCORE', value: (r: (typeof rows)[number]) => scoreCell(r) }] : []),
          { header: 'COMPANY', value: (r) => r.company, max: 20 },
          { header: 'TITLE', value: (r) => r.title, max: 55 },
          { header: 'LOCATION', value: (r) => r.locations.join('; '), max: 30 },
          { header: 'REMOTE', value: (r) => r.remotePolicy ?? '' },
          { header: 'LEVEL', value: (r) => r.seniority ?? '' },
          { header: 'POSTED', value: (r) => fmtDate(r.postedAt) },
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

type Db = ReturnType<typeof createDb>['db'];
type Log = ReturnType<typeof createLogger>;

function profileDir(): string {
  const facts = findUp(join('profile', 'facts.yaml'));
  return facts ? dirname(facts) : 'profile';
}

function scoreCell(r: { score: number | null; method: string | null }): string {
  if (r.method === null) return '-';
  if (r.method === 'llm') return String(r.score);
  return r.method === 'filtered' ? 'filt' : 'low';
}

async function runEmbed(db: Db, config: AppConfig, log: Log) {
  const tty = process.stderr.isTTY;
  if (tty) process.stderr.write('loading embedding model…');
  const embedder = await createEmbedder(config);
  const s = await embedPending(
    { db, embedder, log },
    { onProgress: (n) => tty && process.stderr.write(`\rembedding jobs: ${n}            `) },
  );
  if (tty) process.stderr.write('\r\x1b[K');
  return s;
}

async function llmCheck(env: Env, config: AppConfig, db: Db, log: Log): Promise<number> {
  const llm = createLLM(env, config, db, log);
  const tasks = ['match', 'tailor', 'outreach', 'extract'] as const;
  console.log(
    table(
      tasks.map((t) => ({ t, ...llm.route(t) })),
      [
        { header: 'TASK', value: (r) => r.t },
        { header: 'PROVIDER', value: (r) => r.provider.name },
        { header: 'MODEL', value: (r) => r.model },
      ],
    ),
  );
  const used = new Set(tasks.map((t) => llm.route(t).provider.name));
  let ok = true;
  if (used.has('claude-code')) {
    const s = await checkClaudeCli(env.CLAUDE_CLI_PATH);
    console.log(`\nclaude-code: ${s.ok ? `ok (${s.version}${s.loggedIn ? ', logged in' : ''})` : `PROBLEM: ${s.problem}`}`);
    ok &&= s.ok;
  }
  if (used.has('openrouter')) console.log(`\nopenrouter: API key ${env.OPENROUTER_API_KEY ? 'set' : 'MISSING'}`);
  const u = await llmUsageSummary(db, new Date(Date.now() - 24 * 3600_000));
  console.log(`\nlast 24h: ${u.calls} calls (${u.failed} failed), ${u.promptTokens}+${u.completionTokens} tokens, $${u.costUsd.toFixed(4)}`);
  if (ok) {
    const stats = await matchStats(db, (await getActiveProfile(db))?.version ?? null);
    console.log(`jobs: ${stats.openJobs} open, ${stats.embedded} embedded, ${stats.scored.llm} LLM-scored`);
  }
  return ok ? 0 : 1;
}

async function fetchCommand(
  values: { plugin?: string | undefined; company?: string | undefined; concurrency?: string | undefined },
  db: Db,
  databaseUrl: string,
  mode: 'dev' | 'live',
  log: Log,
  config: AppConfig,
): Promise<number> {
  const registry = createRegistry(config);
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

async function tailorCommand(jobArg: string, env: Env, config: AppConfig, db: Db, log: Log): Promise<number> {
  const jobId = await resolveIdPrefix(db, 'jobs', jobArg);
  const check = await checkLatex();
  if (!check.ok) {
    process.stderr.write(
      `warning: ${check.error}. Install TeX Live (which provides latexmk + pdflatex) or set LATEX_BIN; `
        + 'bullets and validation report will still be saved.\n',
    );
  } else if (check.version) {
    process.stdout.write(`using ${check.version}\n`);
  }
  const llm = createLLM(env, config, db, log);
  console.log(`tailoring job ${jobId.slice(0, 8)} (block-based assembler) …`);
  const r = await runTailor(
    { db, registry: createRegistry(config), log, llm, limiter: new DomainRateLimiter(), dryRun: env.MODE !== 'live' },
    { jobId },
  );
  const blocks = r.selection.included_block_ids.length;
  const rewrites = r.selection.bullet_rewrites.length;
  console.log(
    `variant ${r.variant.id.slice(0, 8)} · ${r.variant.status} · ${blocks} blocks · ${rewrites} bullet rewrites`,
  );
  if (r.variant.status === 'rendered' && r.variant.pdfPath) {
    console.log(`\nPDF: ${r.variant.pdfPath} (${r.variant.pdfBytes} bytes)`);
  } else if (r.variant.error) {
    console.log(`\nnote: ${r.variant.error}`);
  }
  return r.variant.status === 'rendered' ? 0 : 1;
}

async function autopilotCommand(
  values: { limit?: string | undefined; live?: boolean | undefined },
  env: Env,
  config: AppConfig,
  db: Db,
  log: Log,
): Promise<number> {
  const live = !!values.live || env.MODE === 'live';
  const outDeps = await outreachDeps({ env, config, db, log, live, gmail: true, llm: true });
  const t = tailorDeps({ env, config, db, log, live });
  const summary = await runAutopilot(
    { db, log, policy: config.autopilot, outreachPolicy: config.outreach, outreachDeps: outDeps, tailorDeps: t },
    { ...(values.limit ? { limit: Number(values.limit) } : {}) },
  );
  console.log(
    `autopilot: ${summary.considered} considered · ${summary.approved} auto-approved · ${summary.escalated} escalated to review · ${summary.skipped} skipped`,
  );
  for (const d of summary.decisions) {
    const confidence = d.overall !== null ? ` conf=${d.overall.toFixed(2)}` : '';
    const marker = d.stage === 'approved' ? '✓' : d.stage === 'skipped' ? '-' : '!';
    console.log(
      `  ${marker} ${d.jobId.slice(0, 8)} ${d.company.slice(0, 20).padEnd(20)} ${d.jobTitle.slice(0, 40).padEnd(40)} ${d.reason}${d.note ? `: ${d.note}` : ''}${confidence}`,
    );
  }
  return summary.escalated || summary.approved ? 0 : 1;
}

function pageFetcher() {
  return createPageFetcher({ limiter: new DomainRateLimiter() });
}

async function discoverAtsCommand(
  target: string | undefined,
  values: { name?: string | undefined; save?: boolean | undefined; missing?: boolean | undefined; limit?: string | undefined; 'no-probe'?: boolean | undefined },
  db: Db,
  log: Log,
  config: AppConfig,
): Promise<number> {
  const pages = pageFetcher();
  const probe = !values['no-probe'];
  if (values.missing) {
    const due = await listCompaniesForAtsCheck(db, {
      checkedBefore: new Date(),
      onlyWithoutSources: true,
      limit: values.limit ? Number(values.limit) : 50,
    });
    if (!due.length) {
      console.log('Every company already has a board (or was checked just now).');
      return 0;
    }
    const rows = [];
    for (const c of due) {
      const r = await discoverAndSave(
        { db, pages, log },
        { name: c.name, domain: c.domain ?? undefined, discoveredVia: 'discover_ats' },
        { probe, minConfidence: config.discovery.minConfidence },
      );
      rows.push({ name: c.name, domain: r.domain ?? '', best: r.best, saved: r.saved?.sourcesCreated ?? 0 });
      process.stderr.isTTY && process.stderr.write(`\rchecked ${rows.length}/${due.length}`);
    }
    if (process.stderr.isTTY) process.stderr.write('\n');
    console.log(
      table(rows, [
        { header: 'COMPANY', value: (r) => r.name, max: 28 },
        { header: 'DOMAIN', value: (r) => r.domain, max: 28 },
        { header: 'ATS', value: (r) => r.best?.atsType ?? '-' },
        { header: 'BOARD', value: (r) => r.best?.boardToken ?? '', max: 40 },
        { header: 'CONF', value: (r) => (r.best ? r.best.confidence.toFixed(2) : '') },
        { header: 'NEW BOARDS', value: (r) => String(r.saved) },
      ]),
    );
    console.log(`\n${rows.filter((r) => r.best).length}/${rows.length} detected`);
    return 0;
  }
  if (!target) throw new UsageError('missing <domain|company name> (or --missing)');
  const looksLikeDomain = normalizeDomain(target) !== null && target.includes('.');
  const input = looksLikeDomain ? { domain: target, name: values.name } : { name: values.name ?? target };
  if (values.save) {
    const name = values.name ?? (looksLikeDomain ? undefined : target);
    if (!name) throw new UsageError('--save with a domain needs --name <company>');
    const r = await discoverAndSave({ db, pages, log }, { ...input, name, discoveredVia: 'discover_ats' }, { probe, minConfidence: config.discovery.minConfidence });
    printDetections(r);
    if (r.saved) {
      console.log(
        `\nsaved: company ${r.saved.companyCreated ? 'created' : `matched by ${r.saved.matchedBy}`} · ${r.saved.sourcesCreated} new board(s)`,
      );
    }
    return r.best ? 0 : 1;
  }
  const r = await discoverAts({ pages, log }, input, { probe });
  printDetections(r);
  return r.best ? 0 : 1;
}

function printDetections(r: DiscoverAtsResult): void {
  if (!r.detections.length) console.log('No ATS detected.');
  else
    console.log(
      table(r.detections, [
        { header: 'ATS', value: (d) => d.atsType },
        { header: 'BOARD', value: (d) => d.boardToken, max: 45 },
        { header: 'CONF', value: (d) => d.confidence.toFixed(2) },
        { header: 'EVIDENCE', value: (d) => d.evidence, max: 70 },
      ]),
    );
  if (r.robotsBlocked.length) console.log(`\nrobots.txt blocked: ${r.robotsBlocked.join(', ')}`);
  if (r.errors.length) console.log(`errors: ${r.errors.slice(0, 5).join('; ')}`);
}

async function discoverCompaniesCommand(
  values: { list?: string | undefined; 'max-new'?: string | undefined; 'dry-run'?: boolean | undefined; concurrency?: string | undefined },
  env: Env,
  config: AppConfig,
  db: Db,
  log: Log,
): Promise<number> {
  if (!values.list) throw new UsageError(`--list is required (${Object.keys(COMPANY_LISTS).join(', ')})`);
  const source = COMPANY_LISTS[values.list];
  if (!source) throw new UsageError(`unknown list ${values.list} (${Object.keys(COMPANY_LISTS).join(', ')})`);
  const settings: AppConfig['discovery']['lists'][string] = config.discovery.lists[values.list] ?? { enabled: true };
  if (settings.enabled === false) {
    console.log(`list ${values.list} is disabled in config.yaml`);
    return 0;
  }
  const s = await runDiscoverCompanies(
    { db, pages: pageFetcher(), log, ...(source.needsLlm ? { llm: createLLM(env, config, db, log) } : {}) },
    {
      list: values.list,
      settings: { urls: settings.urls, regions: settings.regions },
      maxNew: values['max-new'] ? Number(values['max-new']) : (settings.maxNew ?? 100),
      minConfidence: config.discovery.minConfidence,
      dryRun: !!values['dry-run'],
      ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
    },
  );
  if (s.companies.length) {
    console.log(
      table(s.companies, [
        { header: 'COMPANY', value: (r) => r.name, max: 30 },
        { header: 'DOMAIN', value: (r) => r.domain ?? '', max: 28 },
        { header: 'ATS', value: (r) => r.best?.atsType ?? '-' },
        { header: 'BOARD', value: (r) => r.best?.boardToken ?? '', max: 40 },
        { header: 'NOTE', value: (r) => r.error ?? (r.created ? 'new' : ''), max: 40 },
      ]),
    );
  }
  console.log(
    `\n${values['dry-run'] ? '[dry run] ' : ''}list ${s.list}: ${s.candidates} candidates · ${s.unique} unique · ${s.existing} already known · ` +
      `${s.added} added (${s.withAts} with a board, ${s.withoutAts} without) · ${s.errors.length} errors`,
  );
  if (s.errors.length && !s.companies.length) console.log(`errors: ${s.errors.slice(0, 5).join('; ')}`);
  return s.errors.length && !s.added ? 1 : 0;
}

class UsageError extends Error {}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof CmdError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${HELP}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
