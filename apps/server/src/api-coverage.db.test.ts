import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewItem, insertResumeVariant, recordPosting, upsertCompany, upsertCompanySource, upsertContact, upsertIncident } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { loadProfileData, normalizePosting } from '@quarry/core';
import { preferencesSchema } from '@quarry/shared';
import { buildApi } from './api.js';
import { routesFromTree } from './route-tree.js';

// Every HTTP route answers sanely: each (method, route) Fastify registered has an
// entry here, is called once against a seeded database with the server's optional
// dependencies absent, never answers 500, and answers one of the expected codes.
// The behaviour behind each route is tested in depth in the api-*.db.test.ts
// files; this suite makes sure nothing is left uncovered or crashes. A new route
// without an entry fails `every registered route has a smoke entry`.

const adminUrl = testDbAdminUrl();
const H = { 'x-quarry': '1', 'content-type': 'application/json' };
const NIL = '00000000-0000-4000-8000-000000000000';

interface Smoke {
  route: string;
  url: () => string;
  body?: () => unknown;
  /** Allowed status codes (never 500). 503 = the server didn't get that dependency (tested elsewhere with it). */
  expect: number[];
}

describe.skipIf(!adminUrl)('API coverage (every route, postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  const ids = { company: '', source: '', job: '', contact: '', review: '', variant: '', incident: '', profileDir: '' };

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    const profileDir = mkdtempSync(join(tmpdir(), 'cov-profile-'));
    writeFileSync(join(profileDir, 'facts.yaml'), 'facts: []\n');
    writeFileSync(join(profileDir, 'preferences.yaml'), 'roles: [Backend Engineer]\n');
    ids.profileDir = profileDir;
    app = await buildApi({ db: t.db, profileDir, screenshotRoot: mkdtempSync(join(tmpdir(), 'cov-shots-')) });
    const c = await upsertCompany(t.db, { name: 'Acme' });
    ids.company = c.id;
    ids.source = (await upsertCompanySource(t.db, { companyId: c.id, atsType: 'greenhouse', boardToken: 'acme' })).id;
    const raw = { externalId: 'j1', url: 'https://boards.greenhouse.io/acme/jobs/1', applyUrl: null, title: 'Backend Engineer', locations: ['Bengaluru'], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    ids.job = (await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId: c.id }, { sourcePlugin: 'source-greenhouse', companySourceId: ids.source, externalId: 'j1', url: raw.url, payload: {} }, new Date())).jobId;
    await loadProfileData(t.db, [], preferencesSchema.parse({ roles: ['Backend Engineer'] }));
    ids.contact = (await upsertContact(t.db, { companyId: c.id, name: 'Asha Rao', email: 'asha@acme.com' })).contact.id;
    ids.review = (
      await createReviewItem(t.db, { kind: 'attention', pluginId: 'orchestrator', jobId: null, contactId: null, companyId: null, draft: { title: 't', message: 'm', reason: 'incident', url: null } })
    ).id;
    ids.variant = (
      await insertResumeVariant(t.db, {
        jobId: ids.job, profileVersion: 'v', pluginId: 'tailor-resume-latex', templateId: 't', factIds: [], bullets: {}, header: {}, validationReport: [],
        status: 'rendered', pdfPath: null, pdfBytes: null, provider: null, model: null, error: null, confidence: 0.9,
      })
    ).id;
    ids.incident = (await upsertIncident(t.db, { checkId: 'review_backlog', fingerprint: 'review_backlog:pending', severity: 'warn', summary: 's', data: {}, evidenceAt: null })).incident.id;
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const job = () => ids.job;
  const SMOKES: Smoke[] = [
    { route: 'GET /api/health', url: () => '/api/health', expect: [200] },
    { route: 'GET /api/stats', url: () => '/api/stats', expect: [200] },
    { route: 'GET /api/pipeline', url: () => '/api/pipeline', expect: [200] },
    { route: 'POST /api/sources/run', url: () => '/api/sources/run', body: () => ({}), expect: [503] },
    { route: 'GET /api/sweep', url: () => '/api/sweep', expect: [200] },
    { route: 'POST /api/sweep', url: () => '/api/sweep', body: () => ({}), expect: [503] },
    { route: 'GET /api/profile', url: () => '/api/profile', expect: [200] },
    { route: 'GET /api/profile/full', url: () => '/api/profile/full', expect: [200] },
    { route: 'POST /api/profile/facts', url: () => '/api/profile/facts', body: () => ({ id: 'cov-fact', kind: 'skill', content: 'Go' }), expect: [200, 201] },
    { route: 'PATCH /api/profile/facts/:id', url: () => '/api/profile/facts/cov-fact', body: () => ({ content: 'Go, Rust' }), expect: [200] },
    { route: 'DELETE /api/profile/facts/:id', url: () => '/api/profile/facts/cov-fact', expect: [200, 204] },
    { route: 'POST /api/profile/fix', url: () => '/api/profile/fix', body: () => ({ field: 'x', value: 'y' }), expect: [400, 503] },
    { route: 'PUT /api/profile/preferences', url: () => '/api/profile/preferences', body: () => ({ roles: ['Backend Engineer'] }), expect: [200, 400] },
    { route: 'POST /api/profile/import', url: () => '/api/profile/import', body: () => ({}), expect: [406] },
    { route: 'GET /api/companies', url: () => '/api/companies', expect: [200] },
    { route: 'POST /api/companies', url: () => '/api/companies', body: () => ({ name: 'Beta Co' }), expect: [200, 201] },
    { route: 'POST /api/companies/discover-ats', url: () => '/api/companies/discover-ats', body: () => ({ domain: 'example.com' }), expect: [503] },
    { route: 'GET /api/companies/discovered', url: () => '/api/companies/discovered', expect: [200] },
    { route: 'POST /api/companies/:id/tags', url: () => `/api/companies/${ids.company}/tags`, body: () => ({ add: ['gcc'] }), expect: [200, 400] },
    { route: 'GET /api/contacts', url: () => '/api/contacts', expect: [200] },
    { route: 'POST /api/contacts', url: () => '/api/contacts', body: () => ({ companyId: ids.company, name: 'Ravi K', email: 'ravi@acme.com' }), expect: [200, 201] },
    { route: 'POST /api/contacts/enrich', url: () => '/api/contacts/enrich', body: () => ({ companyId: ids.company }), expect: [400, 503] },
    { route: 'POST /api/contacts/import', url: () => '/api/contacts/import', body: () => ({}), expect: [400, 406, 415] },
    { route: 'GET /api/contacts/imports', url: () => '/api/contacts/imports', expect: [200] },
    { route: 'GET /api/contacts/imports/:id', url: () => `/api/contacts/imports/${NIL}`, expect: [404] },
    { route: 'POST /api/contacts/imports/:id/commit', url: () => `/api/contacts/imports/${NIL}/commit`, body: () => ({}), expect: [404] },
    { route: 'POST /api/contacts/imports/:id/discard', url: () => `/api/contacts/imports/${NIL}/discard`, body: () => ({}), expect: [404] },
    { route: 'GET /api/contacts/:id', url: () => `/api/contacts/${ids.contact}`, expect: [200] },
    { route: 'GET /api/jobs', url: () => '/api/jobs', expect: [200] },
    { route: 'POST /api/jobs', url: () => '/api/jobs', body: () => ({ company: 'Gamma', title: 'Platform Engineer', url: 'https://gamma.example/jobs/1', description: 'Build the platform.\n\n- Go\n- Postgres' }), expect: [201] },
    { route: 'GET /api/jobs/:id', url: () => `/api/jobs/${job()}`, expect: [200] },
    { route: 'GET /api/jobs/:id/outreach', url: () => `/api/jobs/${job()}/outreach`, expect: [200] },
    { route: 'POST /api/jobs/:id/deadline', url: () => `/api/jobs/${job()}/deadline`, body: () => ({}), expect: [503] },
    { route: 'POST /api/jobs/:id/tailor', url: () => `/api/jobs/${job()}/tailor`, body: () => ({}), expect: [503] },
    { route: 'GET /api/jobs/:id/resume-variants', url: () => `/api/jobs/${job()}/resume-variants`, expect: [200] },
    { route: 'GET /api/jobs/:id/referrals', url: () => `/api/jobs/${job()}/referrals`, expect: [200] },
    { route: 'POST /api/jobs/:id/referrals/fanout', url: () => `/api/jobs/${job()}/referrals/fanout`, body: () => ({}), expect: [503] },
    { route: 'POST /api/jobs/:id/referrals/approve', url: () => `/api/jobs/${job()}/referrals/approve`, body: () => ({}), expect: [404, 409, 503] },
    { route: 'POST /api/jobs/:id/advance', url: () => `/api/jobs/${job()}/advance`, body: () => ({}), expect: [503] },
    { route: 'POST /api/jobs/:id/apply', url: () => `/api/jobs/${job()}/apply`, body: () => ({}), expect: [503] },
    { route: 'POST /api/jobs/:id/expire', url: () => `/api/jobs/${job()}/expire`, body: () => ({ reason: 'closed by the coverage test' }), expect: [200, 404, 409] },
    { route: 'GET /api/answers', url: () => '/api/answers', expect: [200] },
    { route: 'PATCH /api/answers/:id', url: () => `/api/answers/${NIL}`, body: () => ({ answer: 'x' }), expect: [404] },
    { route: 'DELETE /api/answers/:id', url: () => `/api/answers/${NIL}`, expect: [404] },
    { route: 'POST /api/autopilot/run', url: () => '/api/autopilot/run', body: () => ({}), expect: [503] },
    { route: 'POST /api/autopilot/sequence', url: () => '/api/autopilot/sequence', body: () => ({}), expect: [503] },
    { route: 'GET /api/applications', url: () => '/api/applications', expect: [200] },
    { route: 'GET /api/applications/:id/timeline', url: () => `/api/applications/${job()}/timeline`, expect: [200] },
    { route: 'GET /api/resume', url: () => '/api/resume', expect: [200, 503] },
    { route: 'POST /api/resume/blocks', url: () => '/api/resume/blocks', body: () => ({}), expect: [400, 503] },
    { route: 'PUT /api/resume/blocks/:id', url: () => '/api/resume/blocks/nope', body: () => ({}), expect: [400, 404, 503] },
    { route: 'DELETE /api/resume/blocks/:id', url: () => '/api/resume/blocks/nope', expect: [404, 503] },
    { route: 'PUT /api/resume/order/:section', url: () => '/api/resume/order/projects', body: () => ({}), expect: [400, 503] },
    { route: 'GET /api/resume-variants/:id', url: () => `/api/resume-variants/${ids.variant}`, expect: [200] },
    { route: 'GET /api/resume-variants/:id/pdf', url: () => `/api/resume-variants/${ids.variant}/pdf`, expect: [404] },
    { route: 'GET /api/resumes/library', url: () => '/api/resumes/library', expect: [200] },
    { route: 'GET /api/resumes/library/run', url: () => '/api/resumes/library/run', expect: [200] },
    { route: 'POST /api/resumes/library/generate', url: () => '/api/resumes/library/generate', body: () => ({}), expect: [503] },
    { route: 'POST /api/resumes/benchmarks/pick', url: () => '/api/resumes/benchmarks/pick', body: () => ({}), expect: [200, 400, 409, 503] },
    { route: 'POST /api/resumes/benchmarks/run', url: () => '/api/resumes/benchmarks/run', body: () => ({}), expect: [503] },
    { route: 'POST /api/resumes/benchmarks/jobs', url: () => '/api/resumes/benchmarks/jobs', body: () => ({ categoryId: 'swe-intern', jobId: job() }), expect: [200, 201] },
    { route: 'DELETE /api/resumes/benchmarks/jobs/:categoryId/:jobId', url: () => `/api/resumes/benchmarks/jobs/swe-intern/${job()}`, expect: [200, 204] },
    { route: 'POST /api/resumes/categories', url: () => '/api/resumes/categories', body: () => ({ id: 'cov-cat', name: 'Coverage', jd: 'Backend engineer, Go, Postgres, distributed systems.' }), expect: [200, 201, 400] },
    { route: 'DELETE /api/resumes/categories/:id', url: () => '/api/resumes/categories/cov-cat', expect: [200, 204, 404] },
    { route: 'GET /api/review', url: () => '/api/review', expect: [200] },
    { route: 'GET /api/review/:id', url: () => `/api/review/${ids.review}`, expect: [200] },
    { route: 'PATCH /api/review/:id', url: () => `/api/review/${ids.review}`, body: () => ({ body: 'x' }), expect: [400, 409, 422] },
    { route: 'POST /api/review/:id/approve', url: () => `/api/review/${NIL}/approve`, body: () => ({}), expect: [404] },
    { route: 'POST /api/review/:id/reject', url: () => `/api/review/${NIL}/reject`, body: () => ({}), expect: [404] },
    { route: 'GET /api/review/:id/screenshots/:n', url: () => `/api/review/${ids.review}/screenshots/0`, expect: [404] },
    { route: 'POST /api/outreach/draft', url: () => '/api/outreach/draft', body: () => ({ jobId: job(), contactId: ids.contact }), expect: [503] },
    { route: 'GET /api/outreach/threads', url: () => '/api/outreach/threads', expect: [200] },
    { route: 'GET /api/orchestrator', url: () => '/api/orchestrator', expect: [200] },
    { route: 'POST /api/orchestrator/run', url: () => '/api/orchestrator/run', body: () => ({}), expect: [503] },
    { route: 'POST /api/ops/plugins/:id/resume', url: () => '/api/ops/plugins/actor-apply-workday/resume', body: () => ({}), expect: [200] },
    { route: 'POST /api/ops/llm/resume', url: () => '/api/ops/llm/resume', body: () => ({}), expect: [200] },
    { route: 'DELETE /api/ops/tenant-overrides/:pluginId/:tenant', url: () => '/api/ops/tenant-overrides/actor-apply-workday/acme', expect: [200] },
    { route: 'GET /api/linkedin/drafts', url: () => '/api/linkedin/drafts', expect: [200] },
    { route: 'POST /api/linkedin/drafts/:id/sent', url: () => `/api/linkedin/drafts/${NIL}/sent`, body: () => ({}), expect: [404] },
    { route: 'POST /api/linkedin/drafts/:id/accepted', url: () => `/api/linkedin/drafts/${NIL}/accepted`, body: () => ({}), expect: [404, 503] },
    { route: 'POST /api/linkedin/drafts/:id/replied', url: () => `/api/linkedin/drafts/${NIL}/replied`, body: () => ({}), expect: [404] },
    { route: 'GET /api/linkedin/status', url: () => '/api/linkedin/status', expect: [200] },
    { route: 'POST /api/linkedin/resume', url: () => '/api/linkedin/resume', body: () => ({}), expect: [200, 503] },
    { route: 'POST /api/discovery/run', url: () => '/api/discovery/run', body: () => ({ list: 'yc' }), expect: [400, 503] },
    { route: 'POST /api/discovery/recheck', url: () => '/api/discovery/recheck', body: () => ({}), expect: [503] },
    { route: 'POST /api/discovery/nightly', url: () => '/api/discovery/nightly', body: () => ({}), expect: [503] },
    { route: 'GET /api/chat/sessions', url: () => '/api/chat/sessions', expect: [200] },
    { route: 'POST /api/chat/sessions', url: () => '/api/chat/sessions', body: () => ({ title: 'coverage' }), expect: [201] },
    { route: 'GET /api/chat/sessions/:id', url: () => `/api/chat/sessions/${NIL}`, expect: [404] },
    { route: 'POST /api/chat/sessions/:id/messages', url: () => `/api/chat/sessions/${NIL}/messages`, body: () => ({ text: 'hi' }), expect: [503] },
    { route: 'POST /api/chat/sessions/:id/stop', url: () => `/api/chat/sessions/${NIL}/stop`, body: () => ({}), expect: [503] },
    { route: 'DELETE /api/chat/sessions/:id', url: () => `/api/chat/sessions/${NIL}`, expect: [404] },
    { route: 'GET /api/incidents', url: () => '/api/incidents', expect: [200] },
    { route: 'GET /api/incidents/:id', url: () => `/api/incidents/${ids.incident}`, expect: [200] },
    { route: 'POST /api/incidents/:id/resolve', url: () => `/api/incidents/${ids.incident}/resolve`, body: () => ({}), expect: [200] },
  ];

  it('every registered route has a smoke entry (and every entry is a real route)', () => {
    const registered = routesFromTree(app.printRoutes({ commonPrefix: false })).sort();
    const covered = SMOKES.map((s) => s.route).sort();
    expect(registered.filter((r) => !covered.includes(r))).toEqual([]);
    expect(covered.filter((r) => !registered.includes(r))).toEqual([]);
  });

  it.each(SMOKES.map((s) => [s.route, s] as const))('%s', async (_route, s) => {
    const method = s.route.split(' ')[0] as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    const r = await app.inject({ method, url: s.url(), headers: H, ...(method === 'GET' ? {} : { payload: JSON.stringify(s.body?.() ?? {}) }) });
    expect(r.statusCode, `${s.route} → ${r.statusCode}: ${r.body.slice(0, 300)}`).not.toBe(500);
    expect(s.expect, `${s.route} → ${r.statusCode}: ${r.body.slice(0, 300)}`).toContain(r.statusCode);
  });
});
