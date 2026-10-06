import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { parseAppConfig, preferencesSchema } from '@jobforge/shared';
import { getActiveProfile, recordPosting, upsertCompany } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createDnsResolver, DomainRateLimiter, loadProfileData, normalizePosting, type OutreachDeps } from '@jobforge/core';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import { buildApi, requestGuard } from './api.js';
import { createRegistry } from './plugins.js';
import pino from 'pino';

const adminUrl = testDbAdminUrl();
const H = { 'x-jobforge': '1', 'content-type': 'application/json' };

describe('requestGuard', () => {
  it('allows loopback GETs and same-origin writes with the marker header', () => {
    expect(requestGuard('localhost:3000', 'GET', undefined, undefined)).toBeNull();
    expect(requestGuard('127.0.0.1:3000', 'POST', 'http://127.0.0.1:3000', '1')).toBeNull();
    expect(requestGuard('127.0.0.1:3000', 'POST', 'http://localhost:5173', '1')).toBeNull();
    expect(requestGuard('127.0.0.1:3000', 'POST', undefined, '1')).toBeNull(); // CLI/MCP: no Origin
  });
  it('blocks DNS-rebinding hosts, missing markers, and cross-site origins', () => {
    expect(requestGuard('evil.example:3000', 'GET', undefined, undefined)).toBe('host_not_allowed');
    expect(requestGuard('localhost:3000', 'POST', undefined, undefined)).toBe('missing_x_jobforge_header');
    expect(requestGuard('localhost:3000', 'POST', 'https://evil.example', '1')).toBe('cross_origin');
  });
});

describe.skipIf(!adminUrl)('outreach API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let profileDir: string;
  const ids: Record<string, string> = {};
  const enqueued: string[][] = [];

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    profileDir = mkdtempSync(join(tmpdir(), 'jf-api-profile-'));
    writeFileSync(join(profileDir, 'facts.yaml'), '# facts\nfacts:\n  - {id: skill-go, kind: skill, content: Go}\n');
    writeFileSync(join(profileDir, 'preferences.yaml'), 'roles: [Backend Engineer]\n');
    const config = parseAppConfig({ outreach: { perCompanyPerWeek: 1 } });
    const llm = createLLMClient({
      providers: {
        'claude-code': createFakeProvider(() => ({
          subject: 'Backend role at Acme',
          body: 'Hi Jane,\n\nI noticed the Backend Engineer opening and have been building Go services for three years. Open to a 15-minute chat?',
          fact_ids: ['skill-go'],
          confidence: 0.9,
        })),
      },
      defaultProvider: 'claude-code',
    });
    const deps: OutreachDeps = {
      db: t.db,
      registry: createRegistry(config),
      log: pino({ level: 'silent' }),
      limiter: new DomainRateLimiter(),
      dryRun: true,
      policy: config.outreach,
      llm,
      dns: createDnsResolver({ resolver: { resolveMx: async () => [{ exchange: 'mx.acme.com', priority: 1 }] } }),
    };
    app = await buildApi({
      db: t.db,
      policy: config.outreach,
      outreachDeps: async () => deps,
      enqueueFetch: async (x) => {
        enqueued.push(x);
        return x.map((_, i) => `job${i}`);
      },
      profileDir,
    });
    const { id: companyId } = await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' });
    ids.company = companyId;
    const raw = { externalId: 'j1', url: null, applyUrl: null, title: 'Backend Engineer', locations: [], remotePolicy: null, department: null, descriptionHtml: '<p>Go</p>', postedAt: null, payload: {} };
    ids.job = (
      await recordPosting(t.db, { ...normalizePosting(raw, 'Acme'), companyId }, { sourcePlugin: 's', companySourceId: null, externalId: 'j1', url: null, payload: {} }, new Date())
    ).jobId;
    await loadProfileData(t.db, [{ id: 'skill-go', kind: 'skill', content: 'Go', metrics: {}, tags: [] }], preferencesSchema.parse({ roles: ['Backend Engineer'] }));
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const post = (url: string, body: unknown, headers: Record<string, string> = H) => app.inject({ method: 'POST', url, headers, payload: JSON.stringify(body) });

  it('rejects writes without the marker header or from another site', async () => {
    expect((await post('/api/contacts', { company: 'Acme', name: 'X' }, { 'content-type': 'application/json' })).statusCode).toBe(403);
    expect((await post('/api/contacts', { company: 'Acme', name: 'X' }, { ...H, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/review', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
  });

  it('adds contacts, enriches, drafts, edits, and approves', async () => {
    const jane = await post('/api/contacts', { company: 'Acme', name: 'Jane Doe', role: 'EM' });
    expect(jane.statusCode).toBe(201);
    ids.jane = jane.json().id;
    const sam = await post('/api/contacts', { companyId: ids.company, name: 'Sam Lee', email: 'sam@acme.com' });
    ids.sam = sam.json().id;
    expect((await post('/api/contacts', { company: 'Nope', name: 'X' })).statusCode).toBe(404);

    const enr = await post('/api/contacts/enrich', { companyId: ids.company });
    expect(enr.json().results[0]).toMatchObject({ pattern: '{first}', emailsSet: 1 });

    // No email yet for nobody / duplicate guard / drafting
    const d = await post('/api/outreach/draft', { contactId: ids.jane, jobId: ids.job });
    expect(d.statusCode).toBe(201);
    ids.item = d.json().id;
    expect(d.json()).toMatchObject({ status: 'pending', draft: { to: 'jane@acme.com', subject: 'Backend role at Acme' } });
    expect((await post('/api/outreach/draft', { contactId: ids.jane })).json()).toMatchObject({ error: 'duplicate' });

    const queue = (await app.inject('/api/review')).json();
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ contactName: 'Jane Doe', companyName: 'Acme', jobTitle: 'Backend Engineer' });

    const ed = await app.inject({ method: 'PATCH', url: `/api/review/${ids.item}`, headers: H, payload: JSON.stringify({ subject: 'Go backend role' }) });
    expect(ed.json().draft.subject).toBe('Go backend role');
    expect((await app.inject({ method: 'PATCH', url: `/api/review/${ids.item}`, headers: H, payload: JSON.stringify({ to: 'x' }) })).statusCode).toBe(400);

    const ap = await post(`/api/review/${ids.item}/approve`, {});
    expect(ap.json().status).toBe('approved');
    expect((await post(`/api/review/${ids.item}/approve`, {})).statusCode).toBe(409);
    const detail = (await app.inject(`/api/review/${ids.item}`)).json();
    expect(detail.actions).toEqual([]);

    const out = (await app.inject(`/api/jobs/${ids.job}/outreach`)).json();
    expect(out.company).toMatchObject({ emailDomain: 'acme.com', emailPattern: '{first}' });
    expect(out.contacts).toHaveLength(2);
    expect(out.reviewItems).toHaveLength(1);
  });

  it('rejects', async () => {
    const d = await post('/api/outreach/draft', { contactId: ids.sam });
    const r = await post(`/api/review/${d.json().id}/reject`, { reason: 'not now' });
    expect(r.json()).toMatchObject({ status: 'rejected', decisionNote: 'not now' });
  });

  it('pipeline status, companies, and source runs', async () => {
    const p = (await app.inject('/api/pipeline')).json();
    expect(p.review).toMatchObject({ approved: 1, rejected: 1 });
    expect(p.threads).toEqual({ sent: 0, replied: 0, bounced: 0, closed: 0 });
    const c = await post('/api/companies', { name: 'Linear', domain: 'linear.app', atsType: 'ashby', boardToken: 'linear' });
    expect(c.statusCode).toBe(201);
    expect((await post('/api/companies', { name: 'X', atsType: 'ashby' })).statusCode).toBe(400);
    const run = await post('/api/sources/run', { atsType: 'ashby' });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ queued: 1, boards: ['Linear (ashby:linear)'] });
    expect(enqueued).toHaveLength(1);
  });

  it('edits a profile fact in facts.yaml and reloads the profile', async () => {
    const before = (await getActiveProfile(t.db))!.version;
    const r = await app.inject({ method: 'PATCH', url: '/api/profile/facts/proj-ledger', headers: H, payload: JSON.stringify({ kind: 'project', content: 'Built a ledger' }) });
    expect(r.statusCode).toBe(201);
    expect(r.json().profileVersion).not.toBe(before);
    expect(readFileSync(join(profileDir, 'facts.yaml'), 'utf8')).toContain('# facts');
    expect((await getActiveProfile(t.db))!.facts.map((f) => f.id)).toEqual(['proj-ledger', 'skill-go']);
    const bad = await app.inject({ method: 'PATCH', url: '/api/profile/facts/new-x', headers: H, payload: JSON.stringify({ content: 'no kind' }) });
    expect(bad.statusCode).toBe(400);
  });
});
