import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { sql } from '@jobforge/db';
import type { PageFetcher } from '@jobforge/core';
import { buildApi } from './api.js';

const adminUrl = testDbAdminUrl();
const H = { 'x-jobforge': '1', 'content-type': 'application/json' };

const pages: PageFetcher = {
  async get(url) {
    if (url === 'https://acme.com/careers') {
      return { status: 200, url, chain: [url, 'https://boards.greenhouse.io/acme'], body: '', contentType: 'text/html' };
    }
    return { status: 404, url, chain: [url], body: '', contentType: 'text/html' };
  },
};

describe.skipIf(!adminUrl)('discovery API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db, pages: () => pages });
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('detects without saving, then saves with save=true', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/companies/discover-ats', headers: H, payload: { domain: 'acme.com', probe: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().best).toMatchObject({ atsType: 'greenhouse', boardToken: 'acme', confidence: 1 });
    expect((await t.db.execute(sql`select 1 from companies`)).length).toBe(0);

    const s = await app.inject({
      method: 'POST',
      url: '/api/companies/discover-ats',
      headers: H,
      payload: { name: 'Acme', domain: 'acme.com', save: true, probe: false },
    });
    expect(s.json().saved).toMatchObject({ companyCreated: true, sourcesCreated: 1 });

    const d = await app.inject({ method: 'GET', url: '/api/companies/discovered', headers: { host: 'localhost' } });
    expect(d.json().companies.map((c: { name: string }) => c.name)).toEqual(['Acme']);
  });

  it('validates input and refuses writes without the marker header', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/companies/discover-ats', headers: H, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/companies/discover-ats', headers: H, payload: { domain: 'acme.com', save: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/discovery/run', payload: { list: 'yc' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/discovery/run', headers: H, payload: { list: 'nope' } })).statusCode).toBe(400);
  });
});
