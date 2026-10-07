import { describe, expect, it } from 'vitest';
import { createOpenRouterProvider } from './openrouter.js';
import { extractJson } from './provider.js';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const seen: Captured[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = responses[Math.min(seen.length - 1, responses.length - 1)]!;
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

const completion = (content: string) => ({
  model: 'openai/gpt-4o-mini-2024',
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, cost: 0.0002 },
});
const req = { system: 'SYS', prompt: 'P', jsonSchema: { type: 'object' }, model: 'openai/gpt-4o-mini' };

describe('openrouter adapter', () => {
  it('requests json_schema output and parses usage + cost', async () => {
    const f = fakeFetch([{ status: 200, body: completion('{"a":1}') }]);
    const p = createOpenRouterProvider({ apiKey: 'sk-test', defaultModel: 'm', fetch: f.fn });
    const res = await p.complete(req);
    expect(res).toEqual({
      data: { a: 1 },
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60, costUsd: 0.0002 },
      model: 'openai/gpt-4o-mini-2024',
    });
    const sent = f.seen[0]!;
    expect(sent.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent.headers.authorization).toBe('Bearer sk-test');
    expect(sent.body).toMatchObject({
      model: 'openai/gpt-4o-mini',
      response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } },
      provider: { require_parameters: true },
    });
  });

  it('falls back to JSON-only prompting when response_format is rejected, and remembers it', async () => {
    const f = fakeFetch([
      { status: 404, body: { error: { message: 'No endpoints found that support response_format' } } },
      { status: 200, body: completion('Sure!\n```json\n{"a":2}\n```') },
    ]);
    const p = createOpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: f.fn });
    expect((await p.complete(req)).data).toEqual({ a: 2 });
    expect(f.seen[1]!.body.response_format).toBeUndefined();
    expect(JSON.stringify(f.seen[1]!.body.messages)).toContain('JSON Schema');
    await p.complete(req);
    expect(f.seen).toHaveLength(3); // no second json_schema attempt
    expect(f.seen[2]!.body.response_format).toBeUndefined();
  });

  it('surfaces HTTP errors and never leaks the key', async () => {
    const f = fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
    const p = createOpenRouterProvider({ apiKey: 'sk-secret', defaultModel: 'm', fetch: f.fn, structuredOutputs: 'prompt' });
    const err = (await p.complete(req).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/openrouter 401/);
    expect(err.message).not.toContain('sk-secret');
  });

  it('refuses to start without a key', () => {
    expect(() => createOpenRouterProvider({ apiKey: '', defaultModel: 'm' })).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('extractJson', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Here you go: {"a":{"b":2}} hope that helps', { a: { b: 2 } }],
    ['no json here', undefined],
  ])('%s', (input, expected) => {
    expect(extractJson(input)).toEqual(expected);
  });
});

describe('openrouter web search (Phase 10)', () => {
  it('adds the web plugin and returns url_citation annotations', async () => {
    const body = completion('{"a":1}');
    (body.choices[0]!.message as Record<string, unknown>).annotations = [
      { type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'A' } },
      { type: 'url_citation', url_citation: { url: 'https://example.com/b' } },
    ];
    const f = fakeFetch([{ status: 200, body }]);
    const p = createOpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: f.fn });
    const res = await p.complete({ ...req, webSearch: true });
    expect(f.seen[0]!.body).toMatchObject({ plugins: [{ id: 'web', max_results: 5 }] });
    expect(res.webSearch).toEqual({ used: true, citations: ['https://example.com/a', 'https://example.com/b'] });
  });

  it('answers without search when the web plugin is rejected, and says so', async () => {
    const f = fakeFetch([
      { status: 402, body: { error: { message: 'web search requires credits' } } },
      { status: 200, body: completion('{"a":2}') },
      { status: 200, body: completion('{"a":3}') },
    ]);
    const p = createOpenRouterProvider({ apiKey: 'k', defaultModel: 'm', fetch: f.fn });
    const r1 = await p.complete({ ...req, webSearch: true });
    expect(r1).toMatchObject({ data: { a: 2 }, webSearch: { used: false, citations: [] } });
    expect(f.seen[1]!.body.plugins).toBeUndefined();
    const r2 = await p.complete({ ...req, webSearch: true });
    expect(f.seen[2]!.body.plugins).toBeUndefined(); // remembered
    expect(r2.webSearch?.used).toBe(false);
  });
});
