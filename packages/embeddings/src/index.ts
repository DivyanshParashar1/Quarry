// Local embeddings via @huggingface/transformers (bge-small-en-v1.5, 384 dims)
// — implemented in Phase 2.

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
}

export const EMBEDDING_DIM = 384;
