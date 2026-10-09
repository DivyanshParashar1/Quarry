import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineTailorPlugin,
  type FixedRenderRequest,
  type ResumeComboSpec,
  type TailoredResume,
} from '@jobforge/plugin-sdk';
import { preferencesSchema, resumesConfigSchema } from '@jobforge/shared';
import {
  getJobResume,
  latestRenderedResumeForJob,
  listBenchmarkJobs,
  listBenchmarkScores,
  listLibraryResumes,
  recordPosting,
  retireLibraryResumes,
  sql,
  upsertCompany,
  type DB,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { normalizePosting } from './normalize.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import {
  autoPickBenchmarks,
  categoryForTitle,
  generateLibrary,
  rescaleSimilarity,
  resetAtsContextCache,
  runBenchmarks,
  selectResumeForJob,
  type LibraryDeps,
} from './resume-library.js';
import { silentLogger } from './test-utils.js';

const adminUrl = testDbAdminUrl();
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'library');
const pdf = (name: string) => new Uint8Array(readFileSync(join(FIX, `${name}.pdf`)));

const FILLER =
  ' We are a small team building developer tools used by thousands of companies. You will work closely with senior engineers, ship to production in your first week, and own features end to end. We value clear writing, careful code review and kind collaboration.';
const BACKEND_JD = `## About\n${FILLER}${FILLER}\n\n## Requirements\n- TypeScript and Node.js\n- PostgreSQL and SQL\n- Kubernetes\n\n## Nice to have\n- Redis`;
const ML_JD = `## About\n${FILLER}${FILLER}\n\n## Requirements\n- Python\n- PyTorch\n- LLMs and LangChain\n\n## Nice to have\n- Scikit-learn`;

const COMBOS: ResumeComboSpec[] = [
  { key: 'backend', label: 'Ledger + Realtime', kind: 'combo', includedBlockIds: ['header', 'proj.ledger', 'proj.realtime'], skills: 'projects' },
  { key: 'ml', label: 'DocQA + Anomaly', kind: 'combo', includedBlockIds: ['header', 'proj.docqa', 'proj.anomaly'], skills: 'projects' },
];

function result(pdfBytes: Uint8Array, ids: string[]): TailoredResume {
  return {
    tex: '% stub',
    pdf: pdfBytes,
    pages: 1,
    selection: { included_block_ids: ids, bullet_rewrites: [], tech_stack_rewrites: [], skills_reorder: [], rationale: 'stub', confidence: 1 },
    report: [],
    status: 'rendered',
    error: null,
    confidence: 1,
    provider: 'stub',
    model: 'stub',
    fit: { fontPt: 10, linespread: 1, shortenedBullets: [], rounds: 0, compiles: 1, pages: 1 },
  };
}

/** Stub tailor plugin: library renders map to fixture PDFs; per-job skills rewrite is configurable. */
function stubPlugin(state: { tailorCalls: number; jobRenders: number; jobPdf: string }) {
  return defineTailorPlugin<Record<string, never>>({
    manifest: {
      id: 'tailor-resume-latex',
      version: '0.0.0-test',
      stage: 'tailor',
      description: 'stub',
      configSchema: z.object({}).default({}),
      permissions: { domains: [], llm: false },
      sideEffects: 'none',
    },
    async tailor() {
      state.tailorCalls++;
      return result(pdf('backend'), ['header', 'proj.ledger']);
    },
    async listCombos() {
      return COMBOS;
    },
    async renderFixed(_ctx, req: FixedRenderRequest) {
      const isBackend = req.includedBlockIds.includes('proj.ledger');
      if (req.skills.mode === 'job') {
        state.jobRenders++;
        return result(pdf(isBackend ? state.jobPdf : 'ml'), req.includedBlockIds);
      }
      return result(pdf(isBackend ? 'backend' : 'ml'), req.includedBlockIds);
    },
  });
}

async function addJob(db: DB, companyId: string, id: string, title: string, md: string): Promise<string> {
  const raw = {
    externalId: id,
    url: `https://x.example/${id}`,
    applyUrl: null,
    title,
    locations: ['Bengaluru'],
    remotePolicy: null,
    department: null,
    descriptionHtml: '<p>x</p>',
    postedAt: new Date('2026-09-01T00:00:00Z'),
    payload: {},
  };
  const r = await recordPosting(
    db,
    { ...normalizePosting(raw, 'Acme'), companyId },
    { sourcePlugin: 'source-test', companySourceId: null, externalId: id, url: raw.url, payload: {} },
    new Date(),
  );
  await db.execute(sql`update jobs set description_md = ${md} where id = ${r.jobId}`);
  return r.jobId;
}

describe.skipIf(!adminUrl)('resume library (postgres)', () => {
  let t: TestDb;
  let deps: LibraryDeps;
  const state = { tailorCalls: 0, jobRenders: 0, jobPdf: 'backend-tailored-good' };
  let backendJob: string;
  let mlJob: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    resetAtsContextCache();
    const registry = new PluginRegistry();
    registry.register(stubPlugin(state));
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['TypeScript', 'Python'] });
    await loadProfileData(t.db, [], prefs);
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
    backendJob = await addJob(t.db, companyId, 'b1', 'Backend Engineer Intern', BACKEND_JD);
    mlJob = await addJob(t.db, companyId, 'm1', 'AI Engineer Intern', ML_JD);
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      resumeDir: await mkdtemp(join(tmpdir(), 'jf-library-')),
      policy: resumesConfigSchema.parse({
        benchmarks: {
          perCategory: 5,
          categories: [
            { id: 'backend', label: 'Backend intern', titleKeywords: ['backend engineer intern'] },
            { id: 'ai', label: 'AI engineer', titleKeywords: ['ai engineer'], excludeKeywords: ['senior'] },
          ],
        },
      }),
    };
  });
  afterAll(async () => t?.drop());
  beforeEach(() => {
    state.tailorCalls = 0;
    state.jobRenders = 0;
  });

  it('generates every combo once, skips existing ones, and scrap & regenerate retires the old set', async () => {
    const first = await generateLibrary(deps);
    expect(first.items.map((i) => [i.key, i.status, i.resumeStatus])).toEqual([
      ['backend', 'created', 'rendered'],
      ['ml', 'created', 'rendered'],
    ]);
    const lib = await listLibraryResumes(t.db);
    expect(lib).toHaveLength(2);
    expect(lib.every((v) => v.jobId === null && v.kind === 'combo' && v.resumeText?.includes('Jane Doe'))).toBe(true);

    const again = await generateLibrary(deps);
    expect(again.items.map((i) => i.status)).toEqual(['skipped', 'skipped']);

    const fresh = await generateLibrary(deps, { retire: true });
    expect(fresh.items.map((i) => i.status)).toEqual(['created', 'created']);
    expect(fresh.retired).toBe(2);
    const active = await listLibraryResumes(t.db);
    expect(active.map((v) => v.id).sort()).toEqual(fresh.items.map((i) => i.variantId!).sort());
    expect(await listLibraryResumes(t.db, { includeRetired: true })).toHaveLength(4);
    expect(state.tailorCalls).toBe(0);
  });

  it('auto-picks benchmark JDs by title and scores every library resume under every ATS', async () => {
    const picked = await autoPickBenchmarks(deps);
    expect(picked).toEqual({ backend: [backendJob], ai: [mlJob] });
    expect(await listBenchmarkJobs(t.db)).toHaveLength(2);

    const r = await runBenchmarks(deps);
    expect(r).toEqual({ resumes: 2, jobs: 2, scored: 4 });
    const rows = await listBenchmarkScores(t.db);
    expect(rows).toHaveLength(4);
    const cells = rows[0]!.scores as Record<string, { score: number }>;
    expect(Object.keys(cells).sort()).toEqual(['ashby', 'generic', 'greenhouse', 'lever', 'smartrecruiters', 'successfactors', 'taleo', 'workday']);
  });

  it('picks the best combo for a job with no block-selection call and keeps the tailored skills when ATS rises', async () => {
    const r = await selectResumeForJob(deps, backendJob);
    expect(state.tailorCalls).toBe(0);
    expect(state.jobRenders).toBe(1);
    const d = r.decision!;
    const combo = (await listLibraryResumes(t.db)).find((v) => v.id === d.comboVariantId)!;
    expect(combo.label).toBe('Ledger + Realtime');
    expect(d.category).toBe('backend');
    expect(d.candidates).toHaveLength(2);
    expect(d.comboAts!.keywords.hardMissing).toEqual(['Kubernetes']);
    expect(d.tailoredAts!.keywords.hardMissing).toEqual([]);
    expect(d.tailoredAts!.score).toBeGreaterThan(d.comboAts!.score);
    expect(d.kept).toBe('tailored');
    expect(r.variant).toMatchObject({ kind: 'tailored', jobId: backendJob, parentVariantId: combo.id });

    // Apply/outreach resolve the job's resume through the decision.
    expect((await latestRenderedResumeForJob(t.db, backendJob))!.id).toBe(r.variant.id);
    // Asking again re-uses the decision without rendering.
    const again = await selectResumeForJob(deps, backendJob);
    expect(again.cached).toBe(true);
    expect(again.variant.id).toBe(r.variant.id);
    expect(state.jobRenders).toBe(1);
  });

  it('force re-runs the skills rewrite and falls back to the combo when the ATS score drops', async () => {
    state.jobPdf = 'backend-tailored-bad';
    const r = await selectResumeForJob(deps, backendJob, { force: true });
    state.jobPdf = 'backend-tailored-good';
    expect(state.jobRenders).toBe(1);
    const d = r.decision!;
    expect(d.kept).toBe('combo');
    expect(d.note).toMatch(/using the combo as-is/);
    expect(r.variant.id).toBe(d.comboVariantId);
    expect((await getJobResume(t.db, backendJob))!.variantId).toBe(d.comboVariantId);
  });

  it('routes an AI JD to the ML combo', async () => {
    const r = await selectResumeForJob(deps, mlJob);
    const combo = (await listLibraryResumes(t.db)).find((v) => v.id === r.decision!.comboVariantId)!;
    expect(combo.label).toBe('DocQA + Anomaly');
    expect(r.decision!.category).toBe('ai');
  });

  it('falls back to full per-job generation when the library is empty', async () => {
    await retireLibraryResumes(t.db);
    const { id: companyId } = await upsertCompany(t.db, { name: 'Other' });
    const job = await addJob(t.db, companyId, 'x1', 'Platform Engineer', BACKEND_JD);
    const r = await selectResumeForJob(deps, job);
    expect(state.tailorCalls).toBe(1);
    expect(r.decision!.kept).toBe('generated');
    expect(r.variant.kind).toBe('generated');
    expect((await getJobResume(t.db, job))!.variantId).toBe(r.variant.id);
  });
});

describe('selector helpers', () => {
  it('rescales cosine similarity to 0–100', () => {
    expect(rescaleSimilarity(0.4, 0.5, 0.9)).toBe(0);
    expect(rescaleSimilarity(0.7, 0.5, 0.9)).toBe(50);
    expect(rescaleSimilarity(0.95, 0.5, 0.9)).toBe(100);
  });

  it('maps a title to the first matching category, honouring excludes', () => {
    const cats = [
      { id: 'swe', label: 'SWE', titleKeywords: ['software engineer intern'], excludeKeywords: ['senior'], createdAt: new Date() },
      { id: 'ai', label: 'AI', titleKeywords: ['ai engineer'], excludeKeywords: [], createdAt: new Date() },
    ];
    expect(categoryForTitle('Software Engineer Intern, Payments', cats)).toBe('swe');
    expect(categoryForTitle('Senior Software Engineer Intern', cats)).toBeNull();
    expect(categoryForTitle('AI Engineer', cats)).toBe('ai');
  });
});
