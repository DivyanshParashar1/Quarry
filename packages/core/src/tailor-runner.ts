import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@jobforge/shared';
import type { FactValidation, Job, TailoredBullet, TailoredHeader, ValidationIssue } from '@jobforge/plugin-sdk';
import {
  appendEvent,
  finishPluginRun,
  getActiveProfile,
  getJobDetail,
  insertResumeVariant,
  startPluginRun,
  type DB,
  type ResumeVariantRow,
} from '@jobforge/db';
import { buildContext, type ContextDeps, type PluginRegistry } from './plugins.js';

// Tailoring runner (PLAN.md §8 Phase 4):
//   1. ask the tailor plugin for selected + rephrased bullets (grounded; validator inside the plugin)
//   2. render Typst to a one-page PDF
//   3. persist resume_variants row (with validation report, pdf path if rendered).

export const DEFAULT_TAILOR = 'tailor-resume-typst';

export class NoTailorProfileError extends Error {
  constructor() {
    super('No profile loaded. Fill in profile/*.yaml and run `jf profile load`.');
  }
}

export class NoTailorJobError extends Error {
  constructor(id: string) {
    super(`job ${id} not found`);
  }
}

export interface TailorRunDeps extends Omit<ContextDeps, 'signal' | 'log'> {
  db: DB;
  registry: PluginRegistry;
  log: Logger;
  /** Where to write rendered PDFs (defaults to <repoRoot>/data/resumes). */
  resumeDir?: string;
  /** Path to the Typst template file (defaults to <repoRoot>/templates/resume.typ). */
  templatePath?: string;
  /** Path to the `typst` binary (defaults to `typst` on PATH). */
  typstBin?: string;
  /** Metadata rendered into the resume header; only displayed, never invented. */
  contact?: { name?: string; headline?: string; contact?: string };
  timeoutMs?: number;
}

export interface TailorRunResult {
  variant: ResumeVariantRow;
  jobId: string;
  profileVersion: string;
  report: FactValidation[];
  dropped: FactValidation[];
  headerIssues: ValidationIssue[];
}

/**
 * Tailor one job: ask the plugin for bullets, render the Typst PDF, store a
 * resume_variants row. Never throws for render failures — the row is still
 * written with `render_failed` so the user can see the validation report.
 */
export async function runTailor(
  deps: TailorRunDeps,
  opts: { jobId: string; pluginId?: string },
): Promise<TailorRunResult> {
  const pluginId = opts.pluginId ?? DEFAULT_TAILOR;
  const loaded = deps.registry.tailor(pluginId);
  const profile = await getActiveProfile(deps.db);
  if (!profile) throw new NoTailorProfileError();
  const detail = await getJobDetail(deps.db, opts.jobId, profile.version);
  if (!detail) throw new NoTailorJobError(opts.jobId);
  const job: Job = {
    id: detail.id,
    companyId: detail.company.id,
    company: detail.company.name,
    title: detail.title,
    normalizedTitle: detail.title,
    locations: detail.locations,
    remotePolicy: detail.remotePolicy as Job['remotePolicy'],
    seniority: detail.seniority,
    descriptionMd: detail.descriptionMd,
    applyUrl: detail.applyUrl,
    postedAt: detail.postedAt,
    embedding: null,
  };

  const log = deps.log.child({ plugin: pluginId, jobId: job.id });
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000);
  const ctx = buildContext(loaded, { ...deps, log, signal });
  const runId = await startPluginRun(deps.db, { pluginId, stage: 'tailor', targetKey: `job:${job.id}` });

  try {
    const raw = (await loaded.plugin.tailor(ctx, job, profile)) as {
      bullets: TailoredBullet[];
      header: TailoredHeader;
      report: FactValidation[];
      dropped: FactValidation[];
      headerIssues: ValidationIssue[];
      provider: string;
      model: string;
    };

    const renderInput = {
      name: deps.contact?.name ?? '',
      headline: deps.contact?.headline ?? '',
      contact: deps.contact?.contact ?? '',
      summary: raw.header.summary,
      skills: raw.header.skills,
      sections: toSections(raw.bullets),
    };

    const templatePath = deps.templatePath ?? defaultTemplatePath();
    const resumeDir = deps.resumeDir ?? defaultResumeDir();
    const typstBin = deps.typstBin ?? process.env.TYPST_BIN ?? 'typst';
    const stableId = hashResumeId(job.id, profile.version, renderInput);
    const pdfPath = join(resumeDir, `${stableId}.pdf`);

    let status: ResumeVariantRow['status'];
    let bytes: number | null = null;
    let error: string | null = null;
    let pdfPathOrNull: string | null = null;

    if (!raw.bullets.length) {
      status = 'validation_failed';
      error = `all ${raw.report.length} bullets failed validation`;
      log.warn({ dropped: raw.dropped.length }, 'tailor: no bullets survived validation');
    } else {
      try {
        await mkdir(resumeDir, { recursive: true });
        await renderPdf({ templatePath, resumeDir, pdfPath, renderInput, typstBin, log, signal });
        bytes = (await stat(pdfPath)).size;
        pdfPathOrNull = pdfPath;
        status = 'rendered';
      } catch (err) {
        status = 'render_failed';
        error = err instanceof Error ? err.message : String(err);
        log.warn({ error }, 'tailor: PDF render failed; bullets and report still saved');
      }
    }

    const variant = await insertResumeVariant(deps.db, {
      jobId: job.id,
      profileVersion: profile.version,
      pluginId,
      templateId: 'default',
      factIds: raw.bullets.map((b) => b.factId),
      bullets: raw.bullets,
      header: raw.header,
      validationReport: raw.report,
      status,
      pdfPath: pdfPathOrNull,
      pdfBytes: bytes,
      provider: raw.provider,
      model: raw.model,
      error,
    });

    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: profile.facts.length,
      itemsOut: raw.bullets.length,
      meta: { variantId: variant.id, status, dropped: raw.dropped.length },
    });
    await appendEvent(deps.db, {
      kind: `tailor.${status}`,
      subjectType: 'job',
      subjectId: job.id,
      payload: { variantId: variant.id, dropped: raw.dropped.length, kept: raw.bullets.length },
    });

    return { variant, jobId: job.id, profileVersion: profile.version, report: raw.report, dropped: raw.dropped, headerIssues: raw.headerIssues };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: profile.facts.length, itemsOut: 0, error: message });
    await appendEvent(deps.db, { kind: 'tailor.failed', subjectType: 'job', subjectId: job.id, payload: { error: message } });
    throw err;
  }
}

interface RenderInput {
  name: string;
  headline: string;
  contact: string;
  summary: string;
  skills: string[];
  sections: { title: string; bullets: string[] }[];
}

function toSections(bullets: TailoredBullet[]): { title: string; bullets: string[] }[] {
  const order: string[] = [];
  const byTitle = new Map<string, string[]>();
  for (const b of bullets) {
    const t = b.section.trim();
    if (!byTitle.has(t)) {
      byTitle.set(t, []);
      order.push(t);
    }
    byTitle.get(t)!.push(b.text);
  }
  return order.map((title) => ({ title, bullets: byTitle.get(title)! }));
}

async function renderPdf(args: {
  templatePath: string;
  resumeDir: string;
  pdfPath: string;
  renderInput: RenderInput;
  typstBin: string;
  log: Logger;
  signal: AbortSignal;
}): Promise<void> {
  const template = await readFile(args.templatePath);
  const workDir = join(args.resumeDir, '.build', `job-${createHash('sha256').update(args.pdfPath).digest('hex').slice(0, 12)}`);
  await mkdir(workDir, { recursive: true });
  const typFile = join(workDir, 'resume.typ');
  const dataFile = join(workDir, 'data.json');
  await Promise.all([writeFile(typFile, template), writeFile(dataFile, JSON.stringify(args.renderInput))]);

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(args.typstBin, ['compile', typFile, args.pdfPath], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const onAbort = () => child.kill('SIGTERM');
    args.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      args.signal.removeEventListener('abort', onAbort);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') rejectSpawn(new Error(`typst binary not found at "${args.typstBin}"; install from https://github.com/typst/typst or set TYPST_BIN`));
      else rejectSpawn(err);
    });
    child.on('close', (code) => {
      args.signal.removeEventListener('abort', onAbort);
      if (code === 0) resolveSpawn();
      else rejectSpawn(new Error(`typst exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

function hashResumeId(jobId: string, profileVersion: string, input: RenderInput): string {
  return createHash('sha256').update(JSON.stringify({ jobId, profileVersion, input })).digest('hex').slice(0, 24);
}

function defaultTemplatePath(): string {
  const found = findUp('templates/resume.typ', dirname(fileURLToPath(import.meta.url)));
  // Fall back to repo-root/templates/resume.typ even if missing: renderPdf will surface a clear error.
  return found ?? resolve(process.cwd(), 'templates', 'resume.typ');
}

function defaultResumeDir(): string {
  // Repo root: nearest ancestor with pnpm-workspace.yaml. Fall back to cwd.
  const anchor = findUp('pnpm-workspace.yaml', dirname(fileURLToPath(import.meta.url)));
  const root = anchor ? dirname(anchor) : process.cwd();
  return resolve(root, 'data', 'resumes');
}

function findUp(name: string, from: string): string | null {
  let dir = from;
  while (true) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Check whether the configured typst binary is available (used by CLI/server for a friendly error). */
export async function checkTypst(typstBin: string = process.env.TYPST_BIN ?? 'typst'): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolveCheck) => {
    const child = spawn(typstBin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolveCheck({ ok: false, error: code === 'ENOENT' ? `typst not found at "${typstBin}"` : err.message });
    });
    child.on('close', (code) => {
      if (code === 0) resolveCheck({ ok: true, version: out.trim() });
      else resolveCheck({ ok: false, error: `typst --version exited ${code}` });
    });
  });
}

