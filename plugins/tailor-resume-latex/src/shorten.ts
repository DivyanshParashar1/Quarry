import { z } from 'zod';
import type { GuardrailIssue, LLMClient, RewriteValidation } from '@jobforge/plugin-sdk';
import type { BulletRef, Shortener } from './fit.js';
import { plainText } from './fit.js';

// Length-only bullet shortening, used by the fit loop once typography has run
// out of room. The LLM may only remove words; the guardrail reverts any rewrite
// that adds a number, a proper noun / tech term, or a LaTeX command that the
// original bullet didn't have, or that isn't actually shorter.

export const SHORTEN_SYSTEM_PROMPT = `You shorten resume bullet points so the resume fits on one page.
Each bullet is LaTeX. Return each one shorter (aim for 20-30% fewer characters).

Rules:
- Only remove or compress words. Keep the meaning and the strongest result.
- Do NOT add any number, metric, name, product, company, or technology that is not
  already in that bullet. Do not change any number.
- Keep LaTeX markup as it is (\\textbf{...}, \\% , $<$ ...). Do not add new commands.
- Return every bullet you were given, with the same id.`;

export const shortenOutputSchema = z.object({
  bullets: z.array(z.object({ id: z.string().min(1), text: z.string().min(1).max(1200) })),
});

export function llmShortener(llm: LLMClient, signal: AbortSignal, maxTokens = 1200): Shortener {
  return async ({ bullets }) => {
    const res = await llm.generate({
      task: 'tailor',
      system: SHORTEN_SYSTEM_PROMPT,
      prompt: buildShortenPrompt(bullets),
      schema: shortenOutputSchema,
      maxTokens,
      signal,
    });
    return res.data.bullets;
  };
}

export function buildShortenPrompt(bullets: BulletRef[]): string {
  return [
    'Shorten these bullets:',
    '',
    ...bullets.map((b) => `- id: ${b.id}\n  text: ${b.text}`),
    '',
    'Return JSON of { bullets: [{ id, text }] }.',
  ].join('\n');
}

/** Guardrail for one shortened bullet. `reverted: true` means keep the original. */
export function validateShortening(id: string, original: string, rewritten: string): RewriteValidation {
  const text = rewritten.trim();
  const issues: GuardrailIssue[] = [];
  const origPlain = plainText(original);
  const newPlain = plainText(text);

  if (!newPlain) issues.push({ kind: 'empty', detail: 'empty rewrite' });
  else if (newPlain.length >= origPlain.length) {
    issues.push({ kind: 'too_long', detail: `${newPlain.length} chars, original ${origPlain.length}` });
  }

  const origNumbers = new Set(numbers(origPlain));
  for (const n of numbers(newPlain)) {
    if (!origNumbers.has(n)) issues.push({ kind: 'invented_number', detail: n });
  }

  const origLower = origPlain.toLowerCase();
  for (const term of termLike(newPlain)) {
    if (!origLower.includes(term.toLowerCase())) issues.push({ kind: 'invented_term', detail: term });
  }

  const origCommands = commands(original);
  for (const c of commands(text)) {
    if (!origCommands.has(c)) issues.push({ kind: 'invented_term', detail: `LaTeX command \\${c}` });
  }
  if (!balanced(text)) issues.push({ kind: 'invented_term', detail: 'unbalanced braces or $' });
  // An unescaped % comments out the rest of the line (and the closing brace).
  if (/(^|[^\\])%/.test(text)) issues.push({ kind: 'invented_term', detail: 'unescaped %' });

  const failed = issues.length > 0;
  return {
    bullet_id: id,
    original,
    rewritten: text,
    status: failed ? 'error' : 'ok',
    issues,
    reverted: failed,
  };
}

function numbers(s: string): string[] {
  return [...s.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
}

/**
 * Words that look like proper nouns or tech terms: inner capitals (TypeScript,
 * gRPC), digits, or tech punctuation (Node.js, C++, CI/CD), or any capitalised
 * word that doesn't start a sentence. A plain capitalised word at the start of
 * a sentence ("Built", "Designed") is a verb, not a term.
 */
export function termLike(plain: string): string[] {
  const out: string[] = [];
  const tokens = plain.split(/\s+/).filter(Boolean);
  let sentenceStart = true;
  for (const raw of tokens) {
    const tok = raw.replace(/^[("'`]+|[)"'`,;:!?]+$|\.+$/g, '');
    const endsSentence = /[.!?]$/.test(raw);
    if (tok) {
      const isTerm =
        /[a-z][A-Z]/.test(tok) ||
        /^[A-Z]{2,}/.test(tok) ||
        (/[A-Za-z]/.test(tok) && /\d/.test(tok)) ||
        /[A-Za-z][.+#/][A-Za-z+#]|[+#]$/.test(tok) ||
        (/^[A-Z]/.test(tok) && !(sentenceStart && /^[A-Z][a-z]+$/.test(tok)));
      if (isTerm) out.push(tok);
    }
    sentenceStart = endsSentence;
  }
  return out;
}

function commands(latex: string): Set<string> {
  return new Set([...latex.matchAll(/\\([a-zA-Z]+)/g)].map((m) => m[1]!));
}

function balanced(latex: string): boolean {
  let depth = 0;
  let dollars = 0;
  for (let i = 0; i < latex.length; i++) {
    const c = latex[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
    else if (c === '$') dollars++;
  }
  return depth === 0 && dollars % 2 === 0;
}
