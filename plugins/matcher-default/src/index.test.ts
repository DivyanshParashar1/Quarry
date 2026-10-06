import { describe, expect, it } from 'vitest';
import { pluginManifestSchema, preferencesSchema, type Job, type Profile } from '@jobforge/plugin-sdk';
import { testContext } from '@jobforge/plugin-sdk/testing';
import { createFakeProvider, createLLMClient, type ProviderRequest } from '@jobforge/llm';
import { createHashEmbedder } from '@jobforge/embeddings';
import plugin, { configSchema, type MatcherConfig } from './index.js';

const embedder = createHashEmbedder();

async function makeJob(id: string, title: string, desc: string, o: Partial<Job> = {}): Promise<Job> {
  const [embedding] = await embedder.embed([`${title} ${desc}`]);
  return {
    id,
    companyId: 'c',
    company: 'Acme',
    title,
    normalizedTitle: title.toLowerCase(),
    locations: ['Bengaluru'],
    remotePolicy: null,
    seniority: null,
    descriptionMd: desc,
    applyUrl: null,
    postedAt: null,
    embedding: embedding!,
    ...o,
  };
}

async function makeProfile(): Promise<Profile> {
  const preferences = preferencesSchema.parse({
    roles: ['Backend Engineer'],
    seniority: ['junior', 'mid'],
    stack: ['go', 'postgres'],
    exclusions: { title_keywords: ['sales'] },
  });
  const summary = 'backend engineer go postgres kubernetes apis';
  const [embedding] = await embedder.embed([summary]);
  return {
    version: 'v1',
    preferences,
    facts: [{ id: 'skill-go', kind: 'skill', content: 'Go, 3 years', metrics: {}, tags: [] }],
    summary,
    embedding: embedding!,
  };
}

/** Answers every ref in the prompt; score encodes the ref so tests can map it back. */
function rubricProvider(opts: { omit?: string[]; fail?: boolean } = {}) {
  return createFakeProvider((req: ProviderRequest) => {
    if (opts.fail) throw new Error('provider down');
    const refs = [...req.prompt.matchAll(/^## (J\d+):/gm)].map((m) => m[1]!).filter((r) => !opts.omit?.includes(r));
    return {
      results: refs.map((ref) => ({
        ref,
        stack_fit: 8,
        seniority_fit: 7,
        location_fit: 9,
        eligibility: 10,
        score: 90 - Number(ref.slice(1)),
        confidence: 0.85,
        reasons: `Strong Go/Postgres overlap for ${ref}.`,
        concerns: [],
      })),
    };
  });
}

const cfg = (o: Partial<MatcherConfig> = {}) => configSchema.parse({ minSimilarity: 0.3, batchSize: 2, ...o });

describe('matcher-default', () => {
  it('has a valid manifest that asks for the LLM', () => {
    expect(pluginManifestSchema.safeParse(plugin.manifest).success).toBe(true);
    expect(plugin.manifest.permissions.llm).toBe(true);
  });

  it('filters, prefilters, and LLM-scores in batches', async () => {
    const profile = await makeProfile();
    const jobs = [
      await makeJob('a', 'Backend Engineer', 'Go postgres kubernetes apis'),
      await makeJob('b', 'Backend Engineer II', 'go postgres apis'),
      await makeJob('c', 'Senior Backend Engineer', 'go postgres', { seniority: 'senior' }),
      await makeJob('d', 'Sales Engineer', 'go postgres apis'),
      await makeJob('e', 'Pastry Chef', 'croissants and laminated dough'),
      await makeJob('f', 'Platform Engineer', 'kubernetes go apis'),
      await makeJob('g', 'Backend Engineer', 'go', { embedding: null }),
    ];
    const provider = rubricProvider();
    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' });
    const results = await plugin.score(testContext(cfg(), undefined, { llm }), jobs, profile);
    const by = Object.fromEntries(results.map((r) => [r.jobId, r]));

    expect(by.c).toMatchObject({ method: 'filtered', score: 0, reasons: expect.stringMatching(/Level senior/) });
    expect(by.d).toMatchObject({ method: 'filtered', reasons: expect.stringMatching(/sales/) });
    expect(by.e).toMatchObject({ method: 'prefilter', score: 0, reasons: expect.stringMatching(/Low similarity/) });
    expect(by.g).toBeUndefined(); // not embedded yet: left for the next run
    for (const id of ['a', 'b', 'f']) {
      expect(by[id]).toMatchObject({ method: 'llm', provider: 'fake', model: 'fake-model' });
      expect(by[id]!.reasons).toMatch(/Strong Go\/Postgres/);
      expect(by[id]!.rubric).toMatchObject({ stack_fit: 8, eligibility: 10, concerns: [] });
      expect(by[id]!.similarity).toBeGreaterThan(0.3);
    }
    expect(provider.calls).toHaveLength(2); // 3 jobs, batch size 2
    expect(provider.calls[0]!.prompt).toContain('# Candidate');
    expect(provider.calls[0]!.prompt).toContain('(skill) Go, 3 years');
    expect(provider.calls[0]!.prompt).not.toContain('Pastry Chef');
  });

  it('sends only the top K by similarity to the LLM', async () => {
    const profile = await makeProfile();
    const jobs = [
      await makeJob('best', 'Backend Engineer', 'go postgres kubernetes apis'),
      await makeJob('ok', 'Engineer', 'go'),
    ];
    const provider = rubricProvider();
    const llm = createLLMClient({ providers: { 'claude-code': provider }, defaultProvider: 'claude-code' });
    const results = await plugin.score(testContext(cfg({ llmTopK: 1, minSimilarity: 0 }), undefined, { llm }), jobs, profile);
    expect(results.find((r) => r.jobId === 'best')!.method).toBe('llm');
    expect(results.find((r) => r.jobId === 'ok')).toMatchObject({ method: 'prefilter', reasons: expect.stringMatching(/outside this run's top 1/) });
  });

  it('leaves jobs the LLM omitted unscored, and survives a failed batch', async () => {
    const profile = await makeProfile();
    const jobs = [await makeJob('a', 'Backend Engineer', 'go postgres'), await makeJob('b', 'Backend Engineer', 'go postgres apis')];
    const llm = createLLMClient({ providers: { 'claude-code': rubricProvider({ omit: ['J2'] }) }, defaultProvider: 'claude-code' });
    const results = await plugin.score(testContext(cfg(), undefined, { llm }), jobs, profile);
    expect(results).toHaveLength(1); // J2 was omitted by the model

    const down = createLLMClient({ providers: { 'claude-code': rubricProvider({ fail: true }) }, defaultProvider: 'claude-code' });
    await expect(plugin.score(testContext(cfg(), undefined, { llm: down }), jobs, profile)).rejects.toThrow(/all 1 LLM batches failed/);
  });

  it('refuses to run without a profile embedding', async () => {
    const profile = { ...(await makeProfile()), embedding: null };
    await expect(plugin.score(testContext(cfg()), [await makeJob('a', 'x', 'y')], profile)).rejects.toThrow(/embed step/);
  });
});
