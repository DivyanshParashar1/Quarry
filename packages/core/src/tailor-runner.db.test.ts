import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defineTailorPlugin,
  preferencesSchema,
  type Job,
  type PluginContext,
  type Profile,
  type TailoredResume,
} from '@jobforge/plugin-sdk';
import {
  getResumeVariant,
  latestRenderedResumeForJob,
  listResumeVariantsForJob,
  recordPosting,
  upsertCompany,
  type DB,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { normalizePosting } from './normalize.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { runTailor, type TailorRunDeps } from './tailor-runner.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();

async function addJob(db: DB, companyId: string, company: string, id: string, title: string, desc: string) {
  const raw = {
    externalId: id,
    url: `https://x.example/${id}`,
    applyUrl: null,
    title,
    locations: ['Bengaluru'],
    remotePolicy: null,
    department: null,
    descriptionHtml: `<p>${desc}</p>`,
    postedAt: new Date('2026-09-01T00:00:00Z'),
    payload: {},
  };
  return recordPosting(
    db,
    { ...normalizePosting(raw, company), companyId },
    { sourcePlugin: 'source-test', companySourceId: null, externalId: id, url: raw.url, payload: {} },
    new Date(),
  );
}

/**
 * A stub tailor plugin that returns a fixed `TailoredResume`. The runner's job
 * is to persist that result; the plugin's actual LaTeX assembly + compile is
 * covered by the plugin's own tests.
 */
function stubTailorPlugin(result: TailoredResume) {
  return defineTailorPlugin<{}>({
    manifest: {
      id: 'tailor-resume-latex',
      version: '0.0.0-test',
      stage: 'tailor',
      description: 'stub',
      configSchema: z.object({}).default({}),
      permissions: { domains: [], llm: false },
      sideEffects: 'none',
    },
    async tailor(_ctx: PluginContext<{}>, _job: Job, _profile: Profile) {
      return result;
    },
  });
}

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n%fake\n');

const RESULT: TailoredResume = {
  tex: '% assembled resume\n\\documentclass{article}\\begin{document}hi\\end{document}\n',
  pdf: PDF_BYTES,
  pages: 1,
  selection: {
    included_block_ids: ['header', 'exp.screenify', 'proj.flashseat'],
    bullet_rewrites: [],
    tech_stack_rewrites: [],
    skills_reorder: [],
    rationale: 'deterministic',
    confidence: 1,
  },
  report: [],
  status: 'rendered',
  error: null,
  confidence: 1,
  provider: 'deterministic',
  model: 'none',
};

describe.skipIf(!adminUrl)('tailor runner (postgres)', () => {
  let t: TestDb;
  let deps: TailorRunDeps;
  let jobId: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    registry.register(stubTailorPlugin(RESULT));
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go', 'Postgres'] });
    await loadProfileData(t.db, [], prefs);
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
    const r = await addJob(t.db, companyId, 'Acme', 'a', 'Senior Backend Engineer', 'Go, Postgres, payments');
    jobId = r.jobId;
    const resumeDir = await mkdtemp(join(tmpdir(), 'jf-resumes-'));
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      resumeDir,
    };
  });
  afterAll(async () => t?.drop());

  it('persists the plugin output as a rendered resume_variant', async () => {
    const r = await runTailor(deps, { jobId });
    expect(r.variant.jobId).toBe(jobId);
    expect(r.variant.status).toBe('rendered');
    expect(r.variant.pdfPath).toBeTruthy();
    expect(existsSync(r.variant.pdfPath!)).toBe(true);
    const pdf = await readFile(r.variant.pdfPath!);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');

    const header = r.variant.header as { rewrites: unknown[] };
    expect(header.rewrites).toEqual([]);
    const meta = r.variant.bullets as { selectedBlockIds: string[]; pages: number | null };
    expect(meta.selectedBlockIds).toEqual(['header', 'exp.screenify', 'proj.flashseat']);
    expect(meta.pages).toBe(1);

    const roundTrip = await getResumeVariant(t.db, r.variant.id);
    expect(roundTrip?.pluginId).toBe('tailor-resume-latex');
    const latest = await latestRenderedResumeForJob(t.db, jobId);
    expect(latest?.id).toBe(r.variant.id);
  });

  it('records render_failed when the plugin returns no PDF', async () => {
    const failRegistry = new PluginRegistry();
    failRegistry.register(stubTailorPlugin({ ...RESULT, pdf: null, pages: null, status: 'render_failed', error: 'no latexmk' }));
    const r = await runTailor({ ...deps, registry: failRegistry }, { jobId });
    expect(r.variant.status).toBe('render_failed');
    expect(r.variant.pdfPath).toBeNull();
    expect(r.variant.error).toMatch(/latexmk/);
    const list = await listResumeVariantsForJob(t.db, jobId);
    expect(list.length).toBeGreaterThan(1);
  });
});
