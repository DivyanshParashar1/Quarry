import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createReviewItem, listContacts, recordPosting, upsertCompany } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { normalizePosting } from '@quarry/core';
import { buildApi } from './api.js';

const adminUrl = testDbAdminUrl();
const H = { 'x-quarry': '1' };

function multipart(filename: string, content: string): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----jftest' + Math.random().toString(16).slice(2);
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
  return { payload, headers: { ...H, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe.skipIf(!adminUrl)('contacts import + manual LinkedIn API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let jobId: string;
  let companyId: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db });
    companyId = (await upsertCompany(t.db, { name: 'Acme' })).id;
    const raw = { externalId: 'j1', url: null, applyUrl: 'https://x.example/j1', title: 'Backend Engineer', locations: [], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    jobId = (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId }, { sourcePlugin: 's', companySourceId: null, externalId: 'j1', url: null, payload: {} }, new Date())).jobId;
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  it('uploads a sheet, previews the EDA report, and commits it', async () => {
    const up = multipart('people.csv', 'Full Name,E-mail,Company\nAsha Rao,asha@acme.com,Acme\nNo Company Person,,\n');
    const r = await app.inject({ method: 'POST', url: '/api/contacts/import', ...up });
    expect(r.statusCode).toBe(201);
    const preview = r.json();
    expect(preview.report.rows).toEqual({ total: 2, importable: 1, skipped: 1 });
    expect(preview.companies[0]).toMatchObject({ name: 'Acme', companyId });

    expect((await app.inject({ url: `/api/contacts/imports/${preview.importId}` })).json().report.format).toBe('generic');
    const list = (await app.inject({ url: '/api/contacts/imports' })).json();
    expect(list.imports[0]).toMatchObject({ id: preview.importId, status: 'preview' });

    const c = await app.inject({ method: 'POST', url: `/api/contacts/imports/${preview.importId}/commit`, headers: { ...H, 'content-type': 'application/json' }, payload: '{}' });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ contactsCreated: 1 });
    expect((await listContacts(t.db, { companyId }))[0]).toMatchObject({ name: 'Asha Rao', source: 'manual_import' });
    const again = await app.inject({ method: 'POST', url: `/api/contacts/imports/${preview.importId}/commit`, headers: { ...H, 'content-type': 'application/json' }, payload: '{}' });
    expect(again.statusCode).toBe(409);
  });

  it('refuses .xls and non-spreadsheets with a clear message', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/contacts/import', ...multipart('old.xls', 'x') });
    expect(r.statusCode).toBe(415);
    expect(r.json().message).toMatch(/Save As \.xlsx/);
  });

  it('lists manual LinkedIn drafts and marks one sent, then replied', async () => {
    const contact = (await listContacts(t.db, { companyId }))[0]!;
    const item = await createReviewItem(t.db, {
      kind: 'referral_ask',
      pluginId: 'actor-linkedin-manual',
      jobId,
      contactId: contact.id,
      companyId,
      draft: { channel: 'linkedin_manual', kind: 'message', profileUrl: 'https://www.linkedin.com/in/asha-rao/', toName: 'Asha Rao', text: 'Hi Asha, would you be open to referring me for the Backend Engineer role?', jobTitle: 'Backend Engineer' },
    });
    const list = (await app.inject({ url: `/api/linkedin/drafts?jobId=${jobId}` })).json();
    expect(list.drafts).toEqual([expect.objectContaining({ id: item.id, contactName: 'Asha Rao', job: expect.objectContaining({ title: 'Backend Engineer', company: 'Acme' }) })]);
    expect(list.drafts[0].linkedin.kind).toBe('message');

    const json = { ...H, 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: `/api/linkedin/drafts/${item.id}/replied`, headers: json, payload: '{}' })).statusCode).toBe(409);
    const sent = await app.inject({ method: 'POST', url: `/api/linkedin/drafts/${item.id}/sent`, headers: json, payload: '{}' });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().item.status).toBe('executed');
    expect((await app.inject({ url: `/api/linkedin/drafts?jobId=${jobId}` })).json().drafts).toEqual([]);
    const replied = await app.inject({ method: 'POST', url: `/api/linkedin/drafts/${item.id}/replied`, headers: json, payload: JSON.stringify({ note: 'will refer' }) });
    expect(replied.json()).toMatchObject({ state: 'replied' });
  });

  it('reports the sweeper and refuses "accepted" without outreach deps', async () => {
    const sweep = (await app.inject({ url: '/api/sweep' })).json();
    expect(sweep).toEqual({ last: null, available: false });
    expect((await app.inject({ method: 'POST', url: '/api/sweep', headers: { ...H, 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(503);
    const r = await app.inject({ method: 'POST', url: '/api/linkedin/drafts/00000000-0000-4000-8000-000000000000/accepted', headers: { ...H, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(503);
  });

  it('lists, edits and deletes saved application answers', async () => {
    const { upsertBankAnswer } = await import('@quarry/db');
    const a = await upsertBankAnswer(t.db, { question: 'Why us?', questionKey: 'why us', answer: 'Because of the payments work.', kind: 'text', origin: 'llm' });
    const json = { ...H, 'content-type': 'application/json' };
    expect((await app.inject({ url: '/api/answers' })).json().answers).toEqual([expect.objectContaining({ id: a.id, question: 'Why us?' })]);
    const p = await app.inject({ method: 'PATCH', url: `/api/answers/${a.id}`, headers: json, payload: JSON.stringify({ answer: 'Payments, and the team.' }) });
    expect(p.json()).toMatchObject({ answer: 'Payments, and the team.' });
    expect((await app.inject({ method: 'DELETE', url: `/api/answers/${a.id}`, headers: json, payload: '{}' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/answers' })).json().answers).toEqual([]);
  });
});
