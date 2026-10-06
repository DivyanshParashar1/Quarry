import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, type ApiClient } from './api-client.js';
import { createJobForgeMcp } from './server.js';

const ID = '11111111-1111-4111-8111-111111111111';

function fakeApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown; query?: unknown }[] = [];
  const api: ApiClient = {
    async get(path, query) {
      calls.push({ method: 'GET', path, query });
      if (path in responses) return responses[path] as never;
      throw new ApiError(404, { error: 'not_found', message: 'not found' });
    },
    async send(method, path, body) {
      calls.push({ method, path, body });
      return { ok: true, path } as never;
    },
  };
  return { api, calls };
}

async function connect(api: ApiClient, elicit?: (msg: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }) {
  const server = createJobForgeMcp(api);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  const prompts: string[] = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      const message = (req.params as { message: string }).message;
      prompts.push(message);
      return elicit(message);
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, prompts };
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const pending = { id: ID, status: 'pending', kind: 'outreach', draft: { to: 'jane@acme.com', toName: 'Jane Doe', subject: 'Hello', body: 'Body text' }, contactEmailConfidence: 0.68 };

describe('jobforge MCP server', () => {
  it('exposes the PLAN §6 tools, with approve marked destructive', async () => {
    const { client } = await connect(fakeApi().api);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['add_company', 'add_contact', 'approve', 'draft_outreach', 'edit_draft', 'find_emails', 'get_job', 'list_jobs', 'list_resume_variants', 'pipeline_status', 'profile_get', 'profile_update_fact', 'reject', 'review_queue', 'run_autopilot', 'run_source', 'tailor_resume'].sort(),
    );
    const approve = tools.find((t) => t.name === 'approve')!;
    expect(approve.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(approve.description).toMatch(/only action with an external side effect/);
    expect(tools.find((t) => t.name === 'list_jobs')!.annotations?.readOnlyHint).toBe(true);
  });

  it('maps tools onto the HTTP API', async () => {
    const { api, calls } = fakeApi({ '/api/jobs': { total: 0, rows: [] } });
    const { client } = await connect(api);
    await client.callTool({ name: 'list_jobs', arguments: { q: 'backend', remote: ['remote', 'hybrid'], view: 'excluded' } });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/jobs', query: { q: 'backend', remote: 'remote,hybrid', method: 'filtered,prefilter', limit: 20 } });
    await client.callTool({ name: 'run_source', arguments: { pluginId: 'source-ashby' } });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/api/sources/run', body: { atsType: 'ashby' } });
    await client.callTool({ name: 'edit_draft', arguments: { id: ID, subject: 'New' } });
    expect(calls[2]).toMatchObject({ method: 'PATCH', path: `/api/review/${ID}`, body: { subject: 'New' } });
    await client.callTool({ name: 'profile_update_fact', arguments: { id: 'skill-go', content: 'Go, 4 years' } });
    expect(calls[3]).toMatchObject({ method: 'PUT', path: '/api/profile/facts/skill-go', body: { content: 'Go, 4 years' } });
  });

  it('reports API errors as tool errors', async () => {
    const { client } = await connect(fakeApi().api);
    const r = await client.callTool({ name: 'get_job', arguments: { id: ID } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/JobForge API 404/);
  });

  it('approve asks the user and only approves on an explicit yes', async () => {
    const yes = fakeApi({ [`/api/review/${ID}`]: pending });
    const c1 = await connect(yes.api, () => ({ action: 'accept', content: { confirm: true } }));
    await c1.client.callTool({ name: 'approve', arguments: { id: ID } });
    expect(c1.prompts[0]).toMatch(/To: Jane Doe <jane@acme.com> \(address 68% sure\)/);
    expect(yes.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/review/${ID}/approve`, body: { overrideCompanyCap: false } });

    for (const answer of [{ action: 'decline' as const }, { action: 'accept' as const, content: { confirm: false } }]) {
      const no = fakeApi({ [`/api/review/${ID}`]: pending });
      const c = await connect(no.api, () => answer);
      const r = await c.client.callTool({ name: 'approve', arguments: { id: ID } });
      expect(JSON.parse(text(r))).toMatchObject({ approved: false });
      expect(no.calls.some((x) => x.method === 'POST')).toBe(false);
    }
  });

  it('approve refuses non-pending drafts; without elicitation it relies on the tool permission prompt', async () => {
    const done = fakeApi({ [`/api/review/${ID}`]: { ...pending, status: 'approved' } });
    const c = await connect(done.api);
    const r = await c.client.callTool({ name: 'approve', arguments: { id: ID } });
    expect(r.isError).toBe(true);
    expect(done.calls.some((x) => x.method === 'POST')).toBe(false);

    const plain = fakeApi({ [`/api/review/${ID}`]: pending });
    const c2 = await connect(plain.api);
    await c2.client.callTool({ name: 'approve', arguments: { id: ID } });
    expect(plain.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/review/${ID}/approve` });
  });
});
