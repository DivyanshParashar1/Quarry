import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { upsertIncident } from '@jobforge/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { setLlmPausedUntil, setPluginPause } from '@jobforge/core';
import { buildApi } from './api.js';

const adminUrl = testDbAdminUrl();
const H = { 'x-jobforge': '1', 'content-type': 'application/json' };

describe.skipIf(!adminUrl)('health API (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let runs = 0;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db, runOrchestrator: async () => (runs++, { findings: 0, opened: [], acted: [], resolved: [], escalated: [], reverted: [] }) });
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  const post = (url: string, body: unknown = {}) => app.inject({ method: 'POST', url, headers: H, payload: JSON.stringify(body) });

  it('lists incidents, filters by status, and resolves one by hand', async () => {
    const { incident } = await upsertIncident(t.db, { checkId: 'source_errors', fingerprint: 'source_errors:x', severity: 'error', summary: 'board down', data: {}, evidenceAt: new Date() });
    let r = await app.inject({ url: '/api/incidents?status=open' });
    expect(r.json().incidents.map((i: { id: string }) => i.id)).toEqual([incident.id]);
    r = await post(`/api/incidents/${incident.id}/resolve`, { note: 'fixed the token' });
    expect(r.json()).toMatchObject({ status: 'resolved' });
    expect((await app.inject({ url: '/api/incidents?status=open' })).json().incidents).toEqual([]);
    expect((await app.inject({ url: `/api/incidents/${incident.id}` })).json().log.at(-1)).toMatchObject({ kind: 'resolved', why: 'by you: fixed the token' });
    expect((await app.inject({ url: '/api/incidents?status=bogus' })).statusCode).toBe(400);
  });

  it('shows the orchestrator status and lets you lift pauses', async () => {
    await setPluginPause(t.db, 'actor-apply-workday', { until: new Date(Date.now() + 3600_000), reason: 'failing' });
    await setLlmPausedUntil(t.db, new Date(Date.now() + 3600_000));
    let s = (await app.inject({ url: '/api/orchestrator' })).json();
    expect(s.pausedPlugins['actor-apply-workday']).toMatchObject({ reason: 'failing' });
    expect(s.llm.pausedUntil).not.toBeNull();
    expect(s.llm.budgetUsd).toBe(5);
    await post('/api/ops/plugins/actor-apply-workday/resume');
    await post('/api/ops/llm/resume');
    s = (await app.inject({ url: '/api/orchestrator' })).json();
    expect(s.pausedPlugins).toEqual({});
    expect(s.llm.pausedUntil).toBeNull();
  });

  it('runs one orchestrator pass on demand', async () => {
    expect((await post('/api/orchestrator/run')).json()).toMatchObject({ findings: 0 });
    expect(runs).toBe(1);
  });
});
