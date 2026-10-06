import { describe, expect, it } from 'vitest';
import { preferencesSchema, pluginManifestSchema, type Job, type Profile } from '@jobforge/plugin-sdk';
import { testContext } from '@jobforge/plugin-sdk/testing';
import { createFakeProvider, createLLMClient } from '@jobforge/llm';
import plugin, { configSchema, tailorOne } from './index.js';

const profile: Profile = {
  version: 'v1',
  preferences: preferencesSchema.parse({ roles: ['Backend Engineer'], stack: ['Go', 'Postgres'] }),
  facts: [
    {
      id: 'exp-acme',
      kind: 'experience',
      content: 'Backend engineer at Acme. Built the payments ledger in Go on Postgres, handling 2M transactions/day.',
      metrics: { transactions_per_day: 2_000_000 },
      tags: ['go', 'postgres'],
    },
    { id: 'skill-go', kind: 'skill', content: 'Go, 3 years', metrics: {}, tags: ['go'] },
  ],
  summary: '',
  embedding: null,
};

const job: Job = {
  id: 'j1',
  companyId: 'c1',
  company: 'Fintech',
  title: 'Backend Engineer',
  normalizedTitle: 'backend engineer',
  locations: ['Remote'],
  remotePolicy: 'remote',
  seniority: null,
  descriptionMd: 'Build the payments ledger in Go on Postgres.',
  applyUrl: null,
  postedAt: null,
  embedding: null,
};

function withLlm(output: unknown) {
  const provider = createFakeProvider(() => output);
  return { provider, llm: createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' }) };
}

describe('tailor-resume-latex', () => {
  it('declares the tailor stage, LLM permission, and no side effects', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest).toMatchObject({ stage: 'tailor', sideEffects: 'none', permissions: { llm: true } });
  });

  it('selects bullets from the fact bank and drops invented ones', async () => {
    const { llm } = withLlm({
      header: { summary: 'Backend engineer with Go and Postgres experience.', skills: ['Go', 'Postgres'] },
      bullets: [
        { factId: 'exp-acme', text: 'Built the Go payments ledger on Postgres handling 2M transactions/day.', section: 'Experience' },
        { factId: 'skill-go', text: 'Go, 3 years.', section: 'Skills' },
        { factId: 'exp-acme', text: 'Rewrote the service in Rust and cut latency 95%.', section: 'Experience' },
      ],
      confidence: 0.9,
    });
    const cfg = configSchema.parse({});
    const r = await tailorOne(testContext(cfg, undefined, { llm }), job, profile);
    expect(r.bullets.map((b) => b.factId)).toEqual(['exp-acme', 'skill-go']);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.text).toMatch(/Rust/);
    expect(r.header.skills).toEqual(['Go', 'Postgres']);
    // 0.9 self-reported minus 0.1 for the one dropped bullet => 0.8.
    expect(r.confidence).toBeCloseTo(0.8, 2);
  });

  it('penalises confidence when the validator has to drop multiple bullets', async () => {
    const { llm } = withLlm({
      header: { summary: '', skills: [] },
      bullets: [
        { factId: 'ghost1', text: 'did a thing', section: 'Experience' },
        { factId: 'ghost2', text: 'did another thing', section: 'Experience' },
        { factId: 'ghost3', text: 'did a third thing', section: 'Experience' },
      ],
      confidence: 1,
    });
    const cfg = configSchema.parse({});
    const r = await tailorOne(testContext(cfg, undefined, { llm }), job, profile);
    expect(r.bullets).toHaveLength(0);
    // 1 - min(0.5, 3*0.1) = 0.7
    expect(r.confidence).toBeCloseTo(0.7, 2);
  });

  it('throws when the profile has no facts', async () => {
    const { llm } = withLlm({ header: { summary: '', skills: [] }, bullets: [], confidence: 0 });
    const cfg = configSchema.parse({});
    await expect(tailorOne(testContext(cfg, undefined, { llm }), job, { ...profile, facts: [] })).rejects.toThrow(/no facts/);
  });
});
