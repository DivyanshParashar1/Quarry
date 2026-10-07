import { describe, it, expect } from 'vitest';
import { pluginManifestSchema, type Company, type Job } from '@jobforge/plugin-sdk';
import { testContext } from '@jobforge/plugin-sdk/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import plugin, { configSchema } from './index.js';

const job: Job = {
  id: 'j1',
  companyId: 'c1',
  company: 'Walmart Global Tech',
  title: 'Software Engineer Intern - 2027',
  normalizedTitle: 'software engineer intern 2027',
  locations: ['Bengaluru'],
  remotePolicy: null,
  seniority: 'intern',
  descriptionMd: 'Summer internship',
  applyUrl: 'https://walmart.wd5.myworkdayjobs.com/x',
  postedAt: new Date('2026-08-01T00:00:00Z'),
  embedding: null,
};
const company: Company = { id: 'c1', name: 'Walmart Global Tech', domain: null, tags: [], emailDomain: null, emailPattern: null, contacts: [] };
const answer = { deadline: '2026-10-31', confidence: 0.75, rationale: 'Previous two cycles closed in late October.', sources: ['https://example.com/2025-cycle'] };

function llm(webSearch: { used: boolean; citations: string[] }, out: unknown = answer) {
  const provider = createFakeProvider(() => out, { webSearch });
  return { provider, llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }) };
}

describe('enricher-deadline', () => {
  it('has a valid manifest (LLM only, no network of its own)', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions).toEqual({ domains: [], llm: true });
  });

  it('asks for a web-searched, cited estimate and merges provider citations', async () => {
    const { provider, llm: client } = llm({ used: true, citations: ['https://example.com/forum'] });
    const r = await plugin.enrich(testContext(configSchema.parse({}), undefined, { llm: client }), job, company);
    expect(r).toEqual({
      deadline: '2026-10-31',
      confidence: 0.75,
      rationale: answer.rationale,
      sources: ['https://example.com/2025-cycle', 'https://example.com/forum'],
      searched: true,
    });
    expect(provider.calls[0]!.webSearch).toBe(true);
    expect(provider.calls[0]!.prompt).toMatch(/2027 batch, what is the typical application close date\? Use web search\. Cite sources\./);
  });

  it('caps confidence without search, or without citations', async () => {
    const noSearch = await plugin.enrich(testContext(configSchema.parse({}), undefined, { llm: llm({ used: false, citations: [] }).llm }), job, company);
    expect(noSearch).toMatchObject({ confidence: 0.35, searched: false });
    expect(noSearch.rationale).toMatch(/^\(estimated without web search\)/);
    const uncited = await plugin.enrich(
      testContext(configSchema.parse({}), undefined, { llm: llm({ used: true, citations: [] }, { ...answer, sources: [] }).llm }),
      job,
      company,
    );
    expect(uncited.confidence).toBe(0.5);
  });

  it('a null deadline has zero confidence; malformed dates are repaired', async () => {
    const r = await plugin.enrich(testContext(configSchema.parse({}), undefined, { llm: llm({ used: true, citations: [] }, { ...answer, deadline: null }).llm }), job, company);
    expect(r).toMatchObject({ deadline: null, confidence: 0 });
    const bad = createFakeProvider((_r, i) => (i === 0 ? { ...answer, deadline: 'end of October' } : answer), { webSearch: { used: true, citations: [] } });
    const r2 = await plugin.enrich(
      testContext(configSchema.parse({}), undefined, { llm: createLLMClient({ providers: { 'claude-code': bad }, defaultProvider: 'claude-code' }) }),
      job,
      company,
    );
    expect(bad.calls).toHaveLength(2);
    expect(r2.deadline).toBe('2026-10-31');
  });
});
