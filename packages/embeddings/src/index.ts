import { createHash } from 'node:crypto';
import type { Embedder } from '@jobforge/shared';

export type { Embedder } from '@jobforge/shared';

// Local embeddings via @huggingface/transformers (PLAN.md §2): bge-small-en-v1.5,
// 384 dims, CLS pooling, L2-normalized. Runs offline after the first model download.

export const EMBEDDING_DIM = 384;
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';

/** bge's instruction for short queries matched against longer passages. */
export const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

export interface LocalEmbedderOptions {
  model?: string;
  cacheDir?: string;
  batchSize?: number;
  /** ONNX weights variant. fp32 is the reference; q8 is ~4x smaller and slightly less accurate. */
  dtype?: 'fp32' | 'q8';
}

/** Loads the model once (downloading it on first use) and embeds in batches. */
export async function createLocalEmbedder(opts: LocalEmbedderOptions = {}): Promise<Embedder> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const batchSize = opts.batchSize ?? 32;
  const { pipeline, env } = await import('@huggingface/transformers');
  if (opts.cacheDir) env.cacheDir = opts.cacheDir;
  const extractor = await pipeline('feature-extraction', model, { dtype: opts.dtype ?? 'fp32' });

  return {
    dim: EMBEDDING_DIM,
    model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const tensor = await extractor(batch, { pooling: 'cls', normalize: true });
        const rows = tensor.tolist() as number[][];
        if (rows[0] && rows[0].length !== EMBEDDING_DIM) {
          throw new Error(`${model} produced ${rows[0].length}-dim vectors; expected ${EMBEDDING_DIM}`);
        }
        out.push(...rows);
      }
      return out;
    },
  };
}

/**
 * Deterministic bag-of-words embedder for tests: hashes tokens into buckets and
 * normalizes. Texts sharing words are similar, so ranking logic is testable
 * without downloading a model.
 */
export function createHashEmbedder(dim = EMBEDDING_DIM): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    dim,
    model: 'hash-bow',
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const v = new Array<number>(dim).fill(0);
        for (const tok of t.toLowerCase().match(/[a-z0-9+#]+/g) ?? []) {
          const h = createHash('md5').update(tok).digest();
          v[h.readUInt32LE(0) % dim]! += 1;
        }
        return normalize(v);
      });
    },
  };
}

export function normalize(v: number[]): number[] {
  const n = Math.hypot(...v);
  return n === 0 ? v : v.map((x) => x / n);
}

/** Cosine similarity; equals the dot product for normalized vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The passage embedded for a job: title and company carry most of the signal, then the description. */
export function jobEmbeddingText(j: { title: string; company: string; locations: string[]; descriptionMd: string | null }): string {
  const desc = (j.descriptionMd ?? '').replace(/[#*_`>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return [`${j.title} at ${j.company}`, j.locations.length ? `Location: ${j.locations.join('; ')}` : '', desc.slice(0, 2000)]
    .filter(Boolean)
    .join('\n');
}
