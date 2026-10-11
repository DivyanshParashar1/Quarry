import type { Job, Preferences } from '@quarry/plugin-sdk';
import { wordRe } from './filters.js';

// Keyword mode: no embeddings, no LLM. A job that passed every hard filter
// (including the title/description keyword gates) is relevant by definition;
// stack keywords found in the posting only rank it among the others.

export interface KeywordOptions {
  /** Score for a job that passes every hard filter with no stack hits. */
  keywordBase: number;
  /** Added per distinct `stack` keyword found in the title or description. */
  keywordPerHit: number;
}

export function keywordScore(job: Job, p: Preferences, o: KeywordOptions): { score: number; titleHits: string[]; stackHits: string[] } {
  const title = job.title.toLowerCase();
  const text = `${title}\n${(job.descriptionMd ?? '').toLowerCase()}`;
  const titleHits = p.keywords.title_any.filter((k) => wordRe(k).test(title));
  const stackHits = p.stack.filter((k) => wordRe(k).test(text));
  return { score: Math.min(100, o.keywordBase + o.keywordPerHit * stackHits.length), titleHits, stackHits };
}
