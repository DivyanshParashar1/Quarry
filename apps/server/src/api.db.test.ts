import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { preferencesSchema } from '@jobforge/shared';
import { recordPosting, saveMatchResults, upsertCompany } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { loadProfileData, normalizePosting } from '@jobforge/core';
import { buildApi } from './api.js';

const adminUrl = testDbAdminUrl();

describe.skipIf(!adminUrl)('dashboard API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db });
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme' });
    const add = async (ext: string, title: string, location: string, remotePolicy: 'remote' | null = null) => {
      const raw = {
        externalId: ext,
        url: `https://x.example/${ext}`,
        applyUrl: null,
        title,
        locations: [location],
        remotePolicy,
        department: null,
        descriptionHtml: `<p>${title} role</p>`,
        postedAt: new Date('2026-09-01T00:00:00Z'),
        payload: {},
      };
      const r = await recordPosting(
        t.db,
        { ...normalizePosting(raw, 'Acme'), companyId },
        { sourcePlugin: 'source-test', companySourceId: null, externalId: ext, url: raw.url, payload: {} },
        new Date(),
      );
      ids[ext] = r.jobId;
    };
    await add('a', 'Backend Engineer', 'Bengaluru');
    await add('b', 'Senior Data Engineer', 'Remote', 'remote');
    await add('c', 'Dentist', 'Houston');
    await add('d', 'Frontend Engineer', 'Pune');

    const { version } = await loadProfileData(t.db, [], preferencesSchema.parse({ roles: ['Backend Engineer'] }));
    const base = { similarity: 0.7, rubric: {}, provider: 'fake', model: 'm' };
    await saveMatchResults(t.db, version, 'matcher-default', [
      { ...base, jobId: ids.a!, method: 'llm', score: 88, rubric: { stack_fit: 9, concerns: [] }, reasons: 'Great Go fit' },
      { ...base, jobId: ids.b!, method: 'llm', score: 61, reasons: 'Some overlap' },
      { ...base, jobId: ids.c!, method: 'filtered', score: 0, similarity: null, provider: null, model: null, reasons: 'Excluded' },
    ]);
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('lists jobs ranked by score, unscored last', async () => {
    const res = await app.inject('/api/jobs');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(4);
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(['Backend Engineer', 'Senior Data Engineer', 'Dentist', 'Frontend Engineer']);
    expect(body.rows[0]).toMatchObject({ score: 88, method: 'llm', reasons: 'Great Go fit', company: 'Acme' });
    expect(body.rows[3]).toMatchObject({ score: null, method: null });
  });

  it('filters', async () => {
    const get = async (qs: string) => (await app.inject(`/api/jobs?${qs}`)).json();
    expect((await get('method=llm')).total).toBe(2);
    expect((await get('method=unscored')).rows[0].title).toBe('Frontend Engineer');
    expect((await get('minScore=70')).rows.map((r: { title: string }) => r.title)).toEqual(['Backend Engineer']);
    expect((await get('remote=remote')).rows[0].title).toBe('Senior Data Engineer');
    expect((await get('location=benga')).total).toBe(1);
    expect((await get('seniority=senior')).total).toBe(1);
    expect((await get('seniority=mid')).total).toBe(3);
    expect((await get('q=engineer&limit=1&offset=1')).rows[0].title).toBe('Senior Data Engineer');
    expect((await get('q=100%25')).total).toBe(0); // LIKE wildcards are escaped
  });

  it('rejects bad query params', async () => {
    expect((await app.inject('/api/jobs?minScore=abc')).statusCode).toBe(400);
    expect((await app.inject('/api/jobs?remote=moon')).statusCode).toBe(400);
    expect((await app.inject('/api/jobs?bogus=1')).statusCode).toBe(400);
  });

  it('returns job detail with the match explanation', async () => {
    const res = await app.inject(`/api/jobs/${ids.a}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Backend Engineer',
      company: { name: 'Acme' },
      descriptionMd: 'Backend Engineer role',
      match: { score: 88, method: 'llm', rubric: { stack_fit: 9 }, reasons: 'Great Go fit' },
      sources: [{ sourcePlugin: 'source-test', url: 'https://x.example/a' }],
    });
    expect((await app.inject('/api/jobs/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await app.inject('/api/jobs/not-a-uuid')).statusCode).toBe(400);
  });

  it('stats, profile, companies', async () => {
    const stats = (await app.inject('/api/stats')).json();
    expect(stats.profile).toMatchObject({ facts: 0, roles: ['Backend Engineer'] });
    expect(stats.match).toEqual({ openJobs: 4, embedded: 0, scored: { llm: 2, prefilter: 0, filtered: 1 }, unscored: 1 });
    expect(stats.llm24h.calls).toBe(0);
    const profile = (await app.inject('/api/profile')).json();
    expect(profile.embedding).toBeUndefined();
    expect(profile.preferences.roles).toEqual(['Backend Engineer']);
    expect((await app.inject('/api/companies')).json()).toEqual({ companies: ['Acme'] });
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });
});
