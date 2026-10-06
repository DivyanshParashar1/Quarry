import { describe, expect, it } from 'vitest';
import { cosine, createHashEmbedder, createLocalEmbedder, EMBEDDING_DIM, jobEmbeddingText } from './index.js';

describe('hash embedder', () => {
  it('is deterministic, normalized, and ranks overlapping text higher', async () => {
    const e = createHashEmbedder();
    const [q, near, far, again] = await e.embed([
      'backend engineer go postgres',
      'senior backend engineer working in go and postgres',
      'retail store associate weekends',
      'backend engineer go postgres',
    ]);
    expect(q).toHaveLength(EMBEDDING_DIM);
    expect(Math.hypot(...q!)).toBeCloseTo(1, 6);
    expect(again).toEqual(q);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
  });
});

describe('jobEmbeddingText', () => {
  it('leads with title and company and truncates long descriptions', () => {
    const t = jobEmbeddingText({ title: 'SWE', company: 'Acme', locations: ['Pune'], descriptionMd: '## About\n' + 'x'.repeat(5000) });
    expect(t.startsWith('SWE at Acme\nLocation: Pune\n')).toBe(true);
    expect(t.length).toBeLessThan(2100);
  });
});

// Downloads ~130MB from huggingface.co on first run, so it's opt-in.
describe.skipIf(process.env.JOBFORGE_EMBED_MODEL_TEST !== '1')('local bge-small embedder (model download)', () => {
  it('produces normalized 384-dim vectors with sensible similarity', async () => {
    const e = await createLocalEmbedder();
    const [a, b, c] = await e.embed(['Backend engineer, Go and Postgres', 'Server-side developer using Golang and SQL', 'Pastry chef']);
    expect(a).toHaveLength(384);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 4);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  }, 300_000);
});
