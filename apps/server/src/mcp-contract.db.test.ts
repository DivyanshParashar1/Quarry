import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTestDb, testDbAdminUrl, type TestDb } from '@jobforge/db/testing';
import { createJobForgeMcp } from '@jobforge/mcp/server';
import { ApiError, type ApiClient } from '@jobforge/mcp/api-client';
import { buildApi } from './api.js';
import { routesFromTree } from './route-tree.js';

// Every MCP tool, called through the real HTTP API: each request it makes must
// hit a route the server registers with that method (a wrong method or path —
// e.g. PUT where the server has PATCH — fails here), and no tool may make the
// server answer 500. Arguments are generated from each tool's input schema.

const adminUrl = testDbAdminUrl();
const ID = '00000000-0000-4000-8000-000000000000';

type JsonSchema = { type?: string | string[]; enum?: unknown[]; format?: string; minimum?: number; minLength?: number; pattern?: string; items?: JsonSchema; properties?: Record<string, JsonSchema>; required?: string[]; anyOf?: JsonSchema[] };

/** A minimal valid value for a JSON schema (required fields only). */
function sample(s: JsonSchema, name = ''): unknown {
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.length) return sample(s.anyOf[0]!, name);
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === 'object') return Object.fromEntries((s.required ?? []).map((k) => [k, sample(s.properties?.[k] ?? {}, k)]));
  if (type === 'array') return [sample(s.items ?? { type: 'string' }, name)];
  if (type === 'number' || type === 'integer') return s.minimum ?? 1;
  if (type === 'boolean') return false;
  if (s.format === 'uuid' || /id$/i.test(name)) return s.format === 'uuid' || /^(id|jobId|contactId|companyId|reviewItemId)$/.test(name) ? ID : 'test-id';
  if (s.format === 'email') return 'a@example.com';
  if (s.format === 'uri' || /url$/i.test(name)) return 'https://example.com/x';
  if (s.pattern) return 'test-id';
  return 'x'.repeat(Math.max(1, s.minLength ?? 1));
}

describe.skipIf(!adminUrl)('MCP ↔ HTTP API contract (postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let client: Client;
  const calls: { method: string; path: string; status: number }[] = [];

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    app = await buildApi({ db: t.db });
    const send = async (method: string, path: string, body?: unknown, query?: Record<string, string | number | undefined>) => {
      const qs = new URLSearchParams(Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== '') as [string, string][]);
      const r = await app.inject({ method: method as 'GET', url: `${path}${qs.size ? `?${qs}` : ''}`, headers: { 'x-jobforge': '1', 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { payload: JSON.stringify(body ?? {}) }) });
      calls.push({ method, path, status: r.statusCode });
      const parsed = r.body ? (JSON.parse(r.body) as unknown) : null;
      if (r.statusCode >= 400) throw new ApiError(r.statusCode, parsed);
      return parsed as never;
    };
    const api: ApiClient = { get: (path, query) => send('GET', path, undefined, query), send: (method, path, body) => send(method, path, body) };
    const server = createJobForgeMcp(api);
    client = new Client({ name: 'contract', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client?.close();
    await app?.close();
    await t?.drop();
  });

  it('every tool hits registered routes with the right method and never a 500', async () => {
    const patterns = routesFromTree(app.printRoutes({ commonPrefix: false })).map((r) => {
      const [method, path] = r.split(' ') as [string, string];
      return { method, re: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), route: r };
    });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(30);
    const problems: string[] = [];
    for (const tool of tools) {
      const before = calls.length;
      await client.callTool({ name: tool.name, arguments: sample(tool.inputSchema as JsonSchema) as Record<string, unknown> }).catch(() => undefined);
      const made = calls.slice(before);
      if (!made.length) problems.push(`${tool.name}: made no API call`);
      for (const c of made) {
        if (!patterns.some((p) => p.method === c.method && p.re.test(c.path))) problems.push(`${tool.name}: ${c.method} ${c.path} is not a server route`);
        if (c.status >= 500 && c.status !== 503) problems.push(`${tool.name}: ${c.method} ${c.path} → ${c.status}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
