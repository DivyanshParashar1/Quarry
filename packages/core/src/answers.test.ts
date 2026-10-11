import { describe, expect, it } from 'vitest';
import type { ApplicationField } from '@jobforge/plugin-sdk';
import { claims, inventedClaim, isOpenForLlm, llmAnswersConfident, questionKey, similarQuestion } from './answers.js';

const field = (label: string, extra: Partial<ApplicationField> = {}): ApplicationField => ({
  key: label,
  label,
  kind: 'textarea',
  required: true,
  selectors: ['#x'],
  value: null,
  source: null,
  ...extra,
});

describe('which questions the LLM may answer', () => {
  it('skips sensitive, file, checkbox, answered and option-less choice questions', () => {
    expect(isOpenForLlm(field('Why do you want to work at Acme?'))).toBe(true);
    expect(isOpenForLlm(field('How many years of React experience?', { kind: 'select', options: ['0-1', '2-4', '5+'] }))).toBe(true);
    for (const label of ['Expected salary (CTC)', 'What is your notice period?', 'Will you require visa sponsorship?', 'Are you legally authorized to work in India?', 'Gender', 'Date of birth']) {
      expect(isOpenForLlm(field(label))).toBe(false);
    }
    expect(isOpenForLlm(field('Resume', { kind: 'file' }))).toBe(false);
    expect(isOpenForLlm(field('Subscribe?', { kind: 'checkbox' }))).toBe(false);
    expect(isOpenForLlm(field('Why us?', { value: 'Because' }))).toBe(false);
    expect(isOpenForLlm(field('Pick one', { kind: 'select' }))).toBe(false);
  });
});

describe('guardrail', () => {
  const sources = 'Built a Go ledger service handling 2M tx/day at Screenify. Stack: TypeScript, PostgreSQL, Redis. Acme Payments builds payment APIs.';

  it('accepts an answer whose numbers and names come from the sources', () => {
    expect(inventedClaim('I built a Go ledger service handling 2M tx/day, and I would love to build payment APIs at Acme Payments with TypeScript.', sources)).toBeNull();
  });

  it('rejects an invented number, employer or technology', () => {
    expect(inventedClaim('I have 5 years of experience building ledgers.', sources)).toBe('number "5"');
    expect(inventedClaim('At Google I built a ledger service.', sources)).toBe('"Google"');
    expect(inventedClaim('I ran our Kubernetes clusters.', sources)).toBe('"Kubernetes"');
  });

  it('does not treat a sentence-initial verb or "I" as a claim', () => {
    expect(claims('Built a ledger. I shipped it. Designed APIs.').terms).toEqual(['APIs']);
  });
});

describe('answer bank matching', () => {
  it('normalises and matches similar wording', () => {
    expect(questionKey('Why do you want to join Acme? *')).toBe('why do you want to join acme');
    expect(similarQuestion('Why do you want to work here?', 'Why do you want to work here')).toBe(true);
    expect(similarQuestion('Tell us about a project you are proud of', 'Tell us about a project you are proud of.')).toBe(true);
    expect(similarQuestion('Why do you want to work here?', 'Describe a project you led')).toBe(false);
  });
});

describe('auto-approval rule', () => {
  it('needs every LLM answer at ≥ 0.85', () => {
    expect(llmAnswersConfident({ fields: [field('a', { source: 'llm', confidence: 0.9, value: 'x' }), field('b', { source: 'profile', value: 'y' })] })).toBe(true);
    expect(llmAnswersConfident({ fields: [field('a', { source: 'llm', confidence: 0.8, value: 'x' })] })).toBe(false);
    expect(llmAnswersConfident({ fields: [] })).toBe(true);
  });
});
