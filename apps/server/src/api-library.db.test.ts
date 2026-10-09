import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { recordPosting, upsertCompany } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { normalizePosting } from '@jobforge/core';
import { buildApi } from './api.js';
import { benchmarkMatrix } from './routes-library.js';

const adminUrl = testDbAdminUrl();
const H = { 'x-jobforge': '1', 'content-type': 'application/json' };

describe.skipIf(!adminUrl)('resume library API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let jobId: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db });
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
    const raw = { externalId: 'j1', url: null, applyUrl: null, title: 'AI Engineer Intern', locations: [], remotePolicy: null, department: null, descriptionHtml: '<p>LLMs</p>', postedAt: null, payload: {} };
    jobId = (
      await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId }, { sourcePlugin: 's', companySourceId: null, externalId: 'j1', url: null, payload: {} }, new Date())
    ).jobId;
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const send = (method: 'POST' | 'DELETE', url: string, body?: unknown) =>
    app.inject({ method, url, headers: H, payload: JSON.stringify(body ?? {}) });

  it('lists an empty library with the default benchmark categories seeded', async () => {
    const r = await app.inject({ url: '/api/resumes/library' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.resumes).toEqual([]);
    expect(body.categories.map((c: { id: string }) => c.id).sort()).toEqual(['ai-engineer', 'swe-intern']);
    expect(body.run.running).toBe(false);
  });

  it('adds a category, pins and unpins a benchmark JD', async () => {
    expect((await send('POST', '/api/resumes/categories', { id: 'data', label: 'Data engineer', titleKeywords: ['data engineer'] })).statusCode).toBe(201);
    expect((await send('POST', '/api/resumes/benchmarks/jobs', { categoryId: 'ai-engineer', jobId })).statusCode).toBe(201);
    let body = (await app.inject({ url: '/api/resumes/library' })).json();
    expect(body.categories.map((c: { id: string }) => c.id)).toContain('data');
    expect(body.benchmarkJobs).toEqual([expect.objectContaining({ categoryId: 'ai-engineer', jobId, pinned: true, title: 'AI Engineer Intern' })]);
    expect(body.benchmarkJobs[0].descriptionMd).toBeUndefined();

    expect((await send('DELETE', `/api/resumes/benchmarks/jobs/ai-engineer/${jobId}`)).statusCode).toBe(200);
    expect((await send('DELETE', '/api/resumes/categories/data')).statusCode).toBe(200);
    body = (await app.inject({ url: '/api/resumes/library' })).json();
    expect(body.benchmarkJobs).toEqual([]);
    expect(body.categories.map((c: { id: string }) => c.id)).not.toContain('data');
  });

  it('needs tailoring configured to generate or select', async () => {
    expect((await send('POST', '/api/resumes/library/generate', { retire: true })).statusCode).toBe(503);
    expect((await send('POST', `/api/jobs/${jobId}/tailor`, { force: true })).statusCode).toBe(503);
  });

  it('returns the job resume panel shape with no decision yet', async () => {
    const r = (await app.inject({ url: `/api/jobs/${jobId}/resume-variants` })).json();
    expect(r).toEqual({ variants: [], selection: null });
  });
});

describe('benchmarkMatrix', () => {
  it('averages per category and per ATS', () => {
    const m = benchmarkMatrix(
      [
        { variantId: 'v1', jobId: 'a', scores: { greenhouse: { score: 80 }, workday: { score: 60 } } },
        { variantId: 'v1', jobId: 'b', scores: { greenhouse: { score: 70 }, workday: { score: 50 } } },
        { variantId: 'v1', jobId: 'c', scores: { greenhouse: { score: 10 }, workday: { score: 10 } } },
      ],
      [
        { categoryId: 'swe', jobId: 'a' },
        { categoryId: 'swe', jobId: 'b' },
        { categoryId: 'ai', jobId: 'c' },
      ],
    );
    expect(m.v1!.swe).toEqual({ avg: 65, byAts: { greenhouse: 75, workday: 55 }, jobs: 2 });
    expect(m.v1!.ai!.avg).toBe(10);
  });
});
