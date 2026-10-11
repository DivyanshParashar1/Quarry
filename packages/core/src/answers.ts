import { z } from 'zod';
import { listAnswerBank, noteBankAnswerUsed, upsertBankAnswer, type AnswerBankRow, type DB } from '@jobforge/db';
import { chooseOption, type ApplicationDraft, type ApplicationField, type Job } from '@jobforge/plugin-sdk';
import type { LLMClient, Logger, Profile } from '@jobforge/shared';

// Phase 19: answers for application questions the deterministic mapper left
// blank. Order: preferences.yaml answers (already applied by mapAnswers) →
// the answer bank (answers you approved before) → the LLM, grounded only in
// facts.yaml + the JD + your application answers. The LLM never answers
// sensitive questions (EEO, authorization, sponsorship, salary, notice), and
// an answer that brings in a number or a name/technology the sources don't
// contain is rejected (left blank for you).

export const SENSITIVE_QUESTION =
  /salary|ctc|compensation|\bpay\b|remuneration|notice period|sponsor|visa|work permit|authori[sz]|eligible to work|right to work|gender|\bsex\b|race|ethnic|hispanic|veteran|disabilit|pronoun|religio|date of birth|\bage\b|marital|criminal|convict|background check|citizenship/i;

/** Questions the LLM may try: blank, not a file, not EEO-mapped, not sensitive. */
export function isOpenForLlm(f: ApplicationField): boolean {
  if (f.value || f.kind === 'file' || f.kind === 'checkbox' || f.kind === 'multiselect') return false;
  if (SENSITIVE_QUESTION.test(f.label)) return false;
  if ((f.kind === 'select' || f.kind === 'radio') && !f.options?.length) return false;
  return true;
}

export function questionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(optional\)|\*|required/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(questionKey(s).split(' ').filter((t) => t.length > 2));
}

/** Same normalised question, or ≥ 80 % token overlap (Jaccard). */
export function similarQuestion(a: string, b: string): boolean {
  if (questionKey(a) === questionKey(b)) return true;
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return false;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter) >= 0.8;
}

const isChoice = (f: ApplicationField) => f.kind === 'select' || f.kind === 'radio';

export const ANSWER_SYSTEM_PROMPT = `You answer job-application questions for a candidate.

Rules:
- Use ONLY the candidate facts, the candidate's own application answers and the job description given. Never invent experience, employers, numbers, skills, dates or projects.
- If the sources don't support a truthful answer, return answer = null (a human will answer it).
- Write in the first person, specific and concise. Respect each question's character limit.
- For a question with options, answer with one of the options exactly as written, or null.
- Return the ids of the facts each answer relies on, and a confidence 0..1 that the answer is accurate and ready to submit.`;

export const answerSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      answer: z.string().trim().nullable(),
      confidence: z.number().min(0).max(1),
      fact_ids: z.array(z.string()).default([]),
    }),
  ),
});

export function answerPrompt(fields: ApplicationField[], job: Pick<Job, 'title' | 'company' | 'descriptionMd'>, profile: Profile): string {
  const app = profile.preferences.application;
  return [
    `# Job: ${job.title} at ${job.company}`,
    (job.descriptionMd ?? '').slice(0, 3000),
    '',
    '# Candidate facts',
    ...profile.facts.map((f) => `- [${f.id}] (${f.kind}) ${f.content}`),
    '',
    "# Candidate's own application answers",
    ...(app?.answers ?? []).map((a) => `- ${a.match}: ${a.answer}`),
    app?.current_title ? `- current title: ${app.current_title}` : '',
    app?.current_company ? `- current company: ${app.current_company}` : '',
    app?.university ? `- university: ${app.university}${app.degree ? `, ${app.degree}` : ''}` : '',
    '',
    '# Questions',
    ...fields.map((f) => {
      const limit = f.maxLength ?? (f.kind === 'textarea' ? 1200 : 200);
      return `- key: ${f.key}\n  question: ${f.label}\n  ${f.options?.length ? `options: ${f.options.map((o) => JSON.stringify(o)).join(', ')}` : `max characters: ${limit}`}`;
    }),
    '',
    'Return JSON { answers: [{ key, answer, confidence, fact_ids }] } with one entry per question.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Guardrail: no invented facts
// ---------------------------------------------------------------------------

/** Numbers, and words that look like names/technologies (inner caps, digits, tech punctuation, capitalised mid-sentence). */
export function claims(text: string): { numbers: string[]; terms: string[] } {
  const numbers = [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
  const terms: string[] = [];
  let sentenceStart = true;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const tok = raw.replace(/^[("'`]+|[)"'`,;:!?]+$|\.+$/g, '');
    if (tok && tok !== 'I' && tok !== "I'm" && tok !== "I've") {
      const looksLikeTerm =
        /[a-z][A-Z]/.test(tok) ||
        /^[A-Z]{2,}/.test(tok) ||
        (/[A-Za-z]/.test(tok) && /\d/.test(tok)) ||
        /[A-Za-z][.+#/][A-Za-z+#]|[+#]$/.test(tok) ||
        (/^[A-Z]/.test(tok) && !(sentenceStart && /^[A-Z][a-z']+$/.test(tok)));
      if (looksLikeTerm) terms.push(tok);
    }
    sentenceStart = /[.!?]$/.test(raw);
  }
  return { numbers, terms };
}

/** Null when grounded; else the first invented number/term. */
export function inventedClaim(answer: string, sources: string): string | null {
  const src = sources.toLowerCase();
  const { numbers, terms } = claims(answer);
  for (const n of numbers) if (!src.includes(n.toLowerCase())) return `number "${n}"`;
  for (const t of terms) if (!src.includes(t.toLowerCase())) return `"${t}"`;
  return null;
}

function sourceText(fields: ApplicationField[], job: Pick<Job, 'title' | 'company' | 'descriptionMd'>, profile: Profile): string {
  const app = profile.preferences.application;
  return [
    job.title,
    job.company,
    job.descriptionMd ?? '',
    ...profile.facts.map((f) => f.content),
    ...(app?.answers ?? []).flatMap((a) => [a.match, a.answer]),
    app?.current_title ?? '',
    app?.current_company ?? '',
    app?.university ?? '',
    app?.degree ?? '',
    ...profile.preferences.stack,
    ...profile.preferences.roles,
    ...fields.map((f) => f.label),
  ].join('\n');
}

export interface AnswerDeps {
  db: DB;
  log: Logger;
  llm?: LLMClient;
  signal?: AbortSignal;
}

export interface AnswerSummary {
  fromBank: number;
  fromLlm: number;
  rejected: Array<{ key: string; reason: string }>;
  /** The LLM call failed; its questions stay blank for you (the draft is still made). */
  llmError?: string;
}

/**
 * Fill blank fields from the answer bank, then the LLM. Returns the new field
 * list (input untouched) and what happened.
 */
export async function answerOpenFields(
  deps: AnswerDeps,
  fields: ApplicationField[],
  job: Pick<Job, 'title' | 'company' | 'descriptionMd'>,
  profile: Profile,
): Promise<{ fields: ApplicationField[]; summary: AnswerSummary }> {
  const out = fields.map((f) => ({ ...f }));
  const summary: AnswerSummary = { fromBank: 0, fromLlm: 0, rejected: [] };

  // 1. The answer bank.
  const bank = await listAnswerBank(deps.db);
  for (const f of out) {
    if (!isOpenForLlm(f)) continue;
    const hit = findBankAnswer(bank, f);
    if (!hit) continue;
    f.value = hit.value;
    f.source = 'bank';
    f.confidence = 1;
    f.note = 'from your approved answers';
    summary.fromBank++;
    await noteBankAnswerUsed(deps.db, hit.row.id);
  }

  // 2. The LLM, in one call for the rest.
  const open = out.filter(isOpenForLlm);
  if (!open.length || !deps.llm) return { fields: out, summary };
  let res: { data: z.input<typeof answerSchema> };
  try {
    res = await deps.llm.generate({
      task: 'extract',
      system: ANSWER_SYSTEM_PROMPT,
      prompt: answerPrompt(open, job, profile),
      schema: answerSchema,
      maxTokens: 400 + open.length * 250,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    summary.llmError = (err as Error).message.slice(0, 300);
    deps.log.warn({ err: summary.llmError }, 'application answers: LLM call failed; those questions stay blank');
    return { fields: out, summary };
  }
  const sources = sourceText(out, job, profile);
  const factIds = new Set(profile.facts.map((f) => f.id));
  for (const a of res.data.answers) {
    const cited = a.fact_ids ?? [];
    const f = open.find((x) => x.key === a.key);
    if (!f || !a.answer) continue;
    let value: string | null = a.answer.trim();
    let reason: string | null = null;
    if (isChoice(f)) {
      value = chooseOption(value, f.options ?? []);
      if (!value) reason = `"${a.answer}" is not one of the options`;
    } else {
      const limit = f.maxLength ?? (f.kind === 'textarea' ? 1200 : 200);
      if (value.length > limit) reason = `longer than the ${limit}-character limit`;
      else {
        const invented = inventedClaim(value, sources);
        if (invented) reason = `${invented} is not in your facts or the job description`;
      }
    }
    if (cited.some((id) => !factIds.has(id))) reason ??= 'cites a fact that does not exist';
    if (reason) {
      summary.rejected.push({ key: f.key, reason });
      f.note = `LLM answer rejected: ${reason}`;
      continue;
    }
    f.value = value;
    f.source = 'llm';
    f.confidence = a.confidence;
    f.note = cited.length ? `based on ${cited.join(', ')}` : 'based on the job description';
    summary.fromLlm++;
  }
  if (summary.rejected.length) deps.log.info({ rejected: summary.rejected }, 'application answers: LLM answers rejected by the guardrail');
  return { fields: out, summary };
}

function findBankAnswer(bank: AnswerBankRow[], f: ApplicationField): { row: AnswerBankRow; value: string } | null {
  const kind = isChoice(f) ? 'choice' : 'text';
  for (const row of bank) {
    if (row.kind !== kind || !similarQuestion(row.question, f.label)) continue;
    if (kind === 'choice') {
      const opt = chooseOption(row.answer, f.options ?? []);
      if (opt) return { row, value: opt };
      continue;
    }
    if (f.maxLength && row.answer.length > f.maxLength) continue;
    return { row, value: row.answer };
  }
  return null;
}

/** Draft confidence: the field-coverage score, capped by the least confident LLM answer. */
export function draftConfidenceWithLlm(base: number, fields: ApplicationField[]): number {
  const llm = fields.filter((f) => f.source === 'llm').map((f) => f.confidence ?? 0);
  return llm.length ? Math.min(base, ...llm) : base;
}

/** Phase 19 auto-approval rule: every LLM answer at least this confident. */
export const LLM_AUTO_APPROVE_MIN = 0.85;

export function llmAnswersConfident(draft: Pick<ApplicationDraft, 'fields'>, min = LLM_AUTO_APPROVE_MIN): boolean {
  return draft.fields.filter((f) => f.source === 'llm').every((f) => (f.confidence ?? 0) >= min);
}

/**
 * Remember the free-text and choice answers of an application you approved
 * (LLM-written, yours, or reused), so a similar question is answered the same way.
 */
export async function rememberAnswers(db: DB, draft: Pick<ApplicationDraft, 'fields'>): Promise<number> {
  let n = 0;
  for (const f of draft.fields) {
    if (!f.value || !['llm', 'human', 'bank'].includes(f.source ?? '')) continue;
    if (f.kind === 'file' || f.kind === 'checkbox' || f.kind === 'multiselect' || SENSITIVE_QUESTION.test(f.label)) continue;
    await upsertBankAnswer(db, { question: f.label, questionKey: questionKey(f.label), answer: f.value, kind: isChoice(f) ? 'choice' : 'text', origin: f.source! });
    n++;
  }
  return n;
}
