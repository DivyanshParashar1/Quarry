import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preferencesSchema } from '@jobforge/plugin-sdk';
import {
  getResumeVariant,
  latestRenderedResumeForJob,
  listResumeVariantsForJob,
  recordLlmCall,
  recordPosting,
  upsertCompany,
  type DB,
} from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import tailorResume from '@jobforge/tailor-resume-latex';
import { normalizePosting } from './normalize.js';
import { loadProfileData } from './profile-loader.js';
import { PluginRegistry } from './plugins.js';
import { DomainRateLimiter } from './rate-limiter.js';
import { checkLatex, runTailor, type TailorRunDeps } from './tailor-runner.js';
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

const GOOD_RESPONSE = {
  header: {
    summary: 'Backend engineer with Go and Postgres experience building payments systems.',
    skills: ['Go', 'Postgres'],
  },
  bullets: [
    {
      factId: 'exp-acme',
      text: 'Built the Go payments ledger on Postgres handling 2M transactions/day.',
      section: 'Experience',
    },
    {
      factId: 'skill-go',
      text: 'Go experience across production services.',
      section: 'Skills',
    },
    // Invented tech + number: must be dropped by the validator.
    {
      factId: 'exp-acme',
      text: 'Rewrote the service in Rust and cut latency 95%.',
      section: 'Experience',
    },
  ],
  confidence: 0.9,
};

describe.skipIf(!adminUrl)('tailor runner (postgres)', () => {
  let t: TestDb;
  let deps: TailorRunDeps;
  let jobId: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const registry = new PluginRegistry();
    registry.register(tailorResume);
    const prefs = preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go', 'Postgres'] });
    const facts = [
      {
        id: 'exp-acme',
        kind: 'experience' as const,
        content: 'Backend engineer at Acme. Built the payments ledger service in Go on Postgres, handling 2M transactions/day.',
        metrics: { transactions_per_day: 2_000_000 },
        tags: ['go', 'postgres'],
      },
      { id: 'skill-go', kind: 'skill' as const, content: 'Go (3 years)', metrics: {}, tags: ['go'] },
    ];
    await loadProfileData(t.db, facts, prefs);
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
    const r = await addJob(t.db, companyId, 'Acme', 'a', 'Senior Backend Engineer', 'Go, Postgres, payments');
    jobId = r.jobId;
    const provider = createFakeProvider(() => GOOD_RESPONSE);
    const resumeDir = await mkdtemp(join(tmpdir(), 'jf-resumes-'));
    deps = {
      db: t.db,
      registry,
      log: silentLogger,
      limiter: new DomainRateLimiter(),
      dryRun: true,
      resumeDir,
      llm: createLLMClient({
        providers: { 'claude-code': provider },
        defaultProvider: 'claude-code',
        onCall: (rec) => recordLlmCall(t.db, rec),
      }),
      contact: { name: 'Asha K.', headline: 'Backend Engineer', contact: 'asha@example.com' },
    };
  });
  afterAll(async () => t?.drop());

  it('drops invented bullets and persists the variant with the validation report', async () => {
    const r = await runTailor(deps, { jobId });
    expect(r.variant.jobId).toBe(jobId);
    expect(r.variant.factIds).toEqual(['exp-acme', 'skill-go']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.text).toMatch(/Rust/);

    const roundTrip = await getResumeVariant(t.db, r.variant.id);
    expect(roundTrip).toBeTruthy();
    expect(roundTrip!.pluginId).toBe('tailor-resume-latex');
    expect(roundTrip!.confidence).toBeGreaterThan(0);
    const bullets = roundTrip!.bullets as { factId: string; text: string; section: string }[];
    expect(bullets.map((b) => b.factId)).toEqual(['exp-acme', 'skill-go']);
  });

  it('either renders a PDF or records render_failed with a reason', async () => {
    const r = await runTailor(deps, { jobId });
    const list = await listResumeVariantsForJob(t.db, jobId);
    expect(list.length).toBeGreaterThan(0);
    const latex = await checkLatex();
    if (latex.ok) {
      expect(r.variant.status).toBe('rendered');
      expect(r.variant.pdfPath).toBeTruthy();
      expect(existsSync(r.variant.pdfPath!)).toBe(true);
      const head = await readFile(r.variant.pdfPath!);
      expect(head.subarray(0, 4).toString()).toBe('%PDF');
      const latest = await latestRenderedResumeForJob(t.db, jobId);
      expect(latest?.id).toBe(r.variant.id);
    } else {
      expect(r.variant.status).toBe('render_failed');
      expect(r.variant.pdfPath).toBeNull();
      expect(r.variant.error).toMatch(/latex/i);
    }
  });
});
