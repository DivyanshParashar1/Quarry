import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@jobforge/shared';
import type { Job, RewriteValidation, TailorSelection, TailoredResume } from '@jobforge/plugin-sdk';
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

// Tailoring runner (block-based rewrite — CLAUDE.md pivot):
//   1. ask the plugin for an assembled .tex + compiled PDF (plugin owns rendering);
//   2. write both to data/resumes/<variantId>/;
//   3. persist a resume_variants row.
// The old fact-grounded columns (fact_ids, bullets, header) are filled with
// empty values until the Phase 2 migration drops them.

export const DEFAULT_TAILOR = 'tailor-resume-latex';

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
  /** Where to write rendered PDFs/.tex (defaults to <repoRoot>/data/resumes). */
  resumeDir?: string;
  timeoutMs?: number;
}

export interface TailorRunResult {
  variant: ResumeVariantRow;
  jobId: string;
  profileVersion: string;
  selection: TailorSelection;
  report: RewriteValidation[];
  confidence: number;
}

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
  const resumeDir = deps.resumeDir ?? defaultResumeDir();

  try {
    const raw = (await loaded.plugin.tailor(ctx, job, profile)) as TailoredResume;

    const dirName = `${job.id}-${Date.now()}`;
    const outDir = join(resumeDir, dirName);
    await mkdir(outDir, { recursive: true });
    const texPath = join(outDir, 'resume.tex');
    await writeFile(texPath, raw.tex, 'utf8');

    let pdfPath: string | null = null;
    let pdfBytes: number | null = null;
    if (raw.pdf) {
      pdfPath = join(outDir, 'resume.pdf');
      await writeFile(pdfPath, raw.pdf);
      pdfBytes = raw.pdf.byteLength;
    }

    const dbStatus = raw.status === 'rendered' ? 'rendered' : 'render_failed';

    const variant = await insertResumeVariant(deps.db, {
      jobId: job.id,
      profileVersion: profile.version,
      pluginId,
      templateId: 'jakes-resume',
      // Legacy columns — kept until the Phase 2 migration retires them.
      factIds: [],
      bullets: {
        selectedBlockIds: raw.selection.included_block_ids,
        texPath,
        pages: raw.pages,
      },
      header: {
        rewrites: raw.selection.bullet_rewrites,
        techStackRewrites: raw.selection.tech_stack_rewrites,
        skillsReorder: raw.selection.skills_reorder,
        rationale: raw.selection.rationale,
      },
      validationReport: raw.report,
      status: dbStatus,
      pdfPath,
      pdfBytes,
      provider: raw.provider,
      model: raw.model,
      error: raw.error,
      confidence: raw.confidence,
    });

    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: raw.selection.included_block_ids.length,
      itemsOut: raw.pdf ? 1 : 0,
      meta: {
        variantId: variant.id,
        status: dbStatus,
        pages: raw.pages,
        confidence: raw.confidence,
        rewrites: raw.selection.bullet_rewrites.length,
      },
    });
    await appendEvent(deps.db, {
      kind: `tailor.${dbStatus}`,
      subjectType: 'job',
      subjectId: job.id,
      payload: {
        variantId: variant.id,
        pages: raw.pages,
        blocks: raw.selection.included_block_ids.length,
        rewrites: raw.selection.bullet_rewrites.length,
        confidence: raw.confidence,
      },
    });

    return {
      variant,
      jobId: job.id,
      profileVersion: profile.version,
      selection: raw.selection,
      report: raw.report,
      confidence: raw.confidence,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishPluginRun(deps.db, runId, { status: 'failed', itemsIn: 0, itemsOut: 0, error: message });
    await appendEvent(deps.db, { kind: 'tailor.failed', subjectType: 'job', subjectId: job.id, payload: { error: message } });
    throw err;
  }
}

function defaultResumeDir(): string {
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

/** Check whether latexmk is on PATH; used by CLI/server for a friendly error. */
export async function checkLatex(latexBin: string = process.env.LATEX_BIN ?? 'latexmk'): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolveCheck) => {
    const child = spawn(latexBin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolveCheck({ ok: false, error: code === 'ENOENT' ? `latexmk not found at "${latexBin}"` : err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        const version = out.trim().split('\n')[0] ?? '';
        resolveCheck({ ok: true, version });
      } else resolveCheck({ ok: false, error: `latexmk -version exited ${code}` });
    });
  });
}
