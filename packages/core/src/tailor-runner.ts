import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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

// Tailoring runner (PLAN.md §8 Phase 4; LaTeX-swap):
//   1. ask the tailor plugin for selected + rephrased bullets (grounded; validator inside the plugin)
//   2. render Jake's-resume LaTeX template to a one-page PDF via latexmk
//   3. persist resume_variants row (with validation report, pdf path if rendered,
//      self-reported confidence for the autopilot).

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
  /** Where to write rendered PDFs (defaults to <repoRoot>/data/resumes). */
  resumeDir?: string;
  /** Path to the LaTeX template (defaults to <repoRoot>/templates/resume.tex). */
  templatePath?: string;
  /** Path to the `latexmk` binary (defaults to `latexmk` on PATH, override via LATEX_BIN). */
  latexBin?: string;
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
  confidence: number;
}

/**
 * Tailor one job: ask the plugin for bullets, render the LaTeX PDF, store a
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
      confidence: number;
      provider: string;
      model: string;
    };

    const renderInput: RenderInput = {
      name: deps.contact?.name ?? '',
      headline: deps.contact?.headline ?? '',
      contact: deps.contact?.contact ?? '',
      summary: raw.header.summary,
      skills: raw.header.skills,
      sections: toSections(raw.bullets),
    };

    const templatePath = deps.templatePath ?? defaultTemplatePath();
    const resumeDir = deps.resumeDir ?? defaultResumeDir();
    const latexBin = deps.latexBin ?? process.env.LATEX_BIN ?? 'latexmk';
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
        await renderPdf({ templatePath, resumeDir, pdfPath, renderInput, latexBin, log, signal });
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
      templateId: 'jakes-resume',
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
      confidence: raw.confidence,
    });

    await finishPluginRun(deps.db, runId, {
      status: 'succeeded',
      itemsIn: profile.facts.length,
      itemsOut: raw.bullets.length,
      meta: { variantId: variant.id, status, dropped: raw.dropped.length, confidence: raw.confidence },
    });
    await appendEvent(deps.db, {
      kind: `tailor.${status}`,
      subjectType: 'job',
      subjectId: job.id,
      payload: { variantId: variant.id, dropped: raw.dropped.length, kept: raw.bullets.length, confidence: raw.confidence },
    });

    return { variant, jobId: job.id, profileVersion: profile.version, report: raw.report, dropped: raw.dropped, headerIssues: raw.headerIssues, confidence: raw.confidence };
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

/**
 * Minimal LaTeX escape for user-controlled strings in math-free body text.
 * Keeps the renderer safe against stray `&`, `$`, `%`, `#`, `_`, `{`, `}`, `~`, `^`, `\`.
 */
export function escapeLatex(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/** Expand the %%NAME%%/%%CONTACT%%/%%SUMMARY%%/%%SKILLS%%/%%SECTIONS%% placeholders in the template. */
export function fillLatexTemplate(template: string, input: RenderInput): string {
  const summary = input.summary.trim()
    ? `\\begin{center}\\small ${escapeLatex(input.summary.trim())}\\end{center}`
    : '';
  const skills = input.skills.length
    ? `\\section{Skills}\\begin{itemize}[leftmargin=0.15in, label={}]\\small{\\item{${input.skills.map(escapeLatex).join(' $\\cdot$ ')}}}\\end{itemize}`
    : '';
  const sections = input.sections
    .map((s) => {
      const items = s.bullets.map((b) => `  \\resumeItem{${escapeLatex(b)}}`).join('\n');
      return `\\section{${escapeLatex(s.title)}}\n\\resumeSubHeadingListStart\n  \\resumeItemListStart\n${items}\n  \\resumeItemListEnd\n\\resumeSubHeadingListEnd`;
    })
    .join('\n\n');
  return template
    .replace(/%%NAME%%/g, escapeLatex(input.name || 'Candidate'))
    .replace(/%%CONTACT%%/g, escapeLatex(input.contact || ''))
    .replace(/%%SUMMARY%%/g, summary)
    .replace(/%%SKILLS%%/g, skills)
    .replace(/%%SECTIONS%%/g, sections);
}

async function renderPdf(args: {
  templatePath: string;
  resumeDir: string;
  pdfPath: string;
  renderInput: RenderInput;
  latexBin: string;
  log: Logger;
  signal: AbortSignal;
}): Promise<void> {
  const template = await readFile(args.templatePath, 'utf8');
  const filled = fillLatexTemplate(template, args.renderInput);
  const workDir = join(args.resumeDir, '.build', `job-${createHash('sha256').update(args.pdfPath).digest('hex').slice(0, 12)}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const texFile = join(workDir, 'resume.tex');
  await writeFile(texFile, filled);

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    // `-interaction=nonstopmode -halt-on-error` turns any error into a non-zero exit instead of a prompt.
    // No `-silent`: we need latexmk's stdout to surface the real pdflatex error.
    const child = spawn(
      args.latexBin,
      ['-pdf', '-interaction=nonstopmode', '-halt-on-error', basename(texFile)],
      { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    const onAbort = () => child.kill('SIGTERM');
    args.signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      args.signal.removeEventListener('abort', onAbort);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        rejectSpawn(
          new Error(
            `latex binary not found at "${args.latexBin}"; install TeX Live (which provides latexmk + pdflatex) or set LATEX_BIN`,
          ),
        );
      } else rejectSpawn(err);
    });
    child.on('close', async (code) => {
      args.signal.removeEventListener('abort', onAbort);
      if (code === 0) {
        try {
          const produced = join(workDir, 'resume.pdf');
          const data = await readFile(produced);
          await writeFile(args.pdfPath, data);
          resolveSpawn();
        } catch (err) {
          rejectSpawn(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        // The real pdflatex error lives in resume.log (around a line that starts with "!").
        let detail = '';
        try {
          const logText = await readFile(join(workDir, 'resume.log'), 'utf8');
          const errLine = logText.split('\n').findIndex((l) => l.startsWith('!'));
          if (errLine >= 0) detail = logText.split('\n').slice(errLine, errLine + 8).join('\n');
          else detail = logText.split('\n').slice(-20).join('\n');
        } catch {
          detail = (stderr || stdout).trim().split('\n').slice(-20).join('\n');
        }
        rejectSpawn(new Error(`latexmk exited with code ${code}:\n${detail.trim() || '(no output)'}`));
      }
    });
  });
}

function hashResumeId(jobId: string, profileVersion: string, input: RenderInput): string {
  return createHash('sha256').update(JSON.stringify({ jobId, profileVersion, input })).digest('hex').slice(0, 24);
}

function defaultTemplatePath(): string {
  const found = findUp('templates/resume.tex', dirname(fileURLToPath(import.meta.url)));
  return found ?? resolve(process.cwd(), 'templates', 'resume.tex');
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

/** Check whether the configured latexmk binary is available (used by CLI/server for a friendly error). */
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
