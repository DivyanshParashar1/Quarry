import { describe, expect, it } from 'vitest';
import { applicationSchema } from '@quarry/shared';
import { mapAnswers, type ApplyInput, type FormQuestion } from './apply.js';

const applicant = applicationSchema.parse({
  location: 'Bengaluru, India',
  current_company: 'Screenify',
  current_title: 'Founding Engineer Intern',
  work_authorization: { India: 'yes', US: 'no' },
  requires_sponsorship: false,
  answers: [{ match: 'WhatsApp', answer: 'Yes' }],
});
const input = { applicant, profile: { preferences: { graduation_year: null } }, resume: { path: '/r.pdf', resumeVariantId: null } } as unknown as ApplyInput;
const q = (label: string, o: Partial<FormQuestion> = {}): FormQuestion => ({ key: label, label, kind: 'text', required: true, selectors: [], ...o });
const answer = (question: FormQuestion) => mapAnswers([question], input).fields[0]!.value;

describe('mapAnswers', () => {
  it('current or previous employer / title, and country of residence', () => {
    expect(answer(q('Who is your current or previous employer?'))).toBe('Screenify');
    expect(answer(q('What is your current or previous job title?'))).toBe('Founding Engineer Intern');
    expect(answer(q('Most recent company'))).toBe('Screenify');
    expect(answer(q('Please select the country where you currently reside.', { kind: 'select', options: ['India', 'US', 'Other'] }))).toBe('India');
  });

  it('sponsorship follows the country named in the question', () => {
    const opts = { kind: 'select' as const, options: ['Yes, I will require visa sponsorship', 'No, I do not require visa sponsorship'] };
    expect(answer(q('Do you require visa sponsorship to continue working in India?', opts))).toBe('No, I do not require visa sponsorship');
    expect(answer(q('Will you require sponsorship to work in the US?', opts))).toBe('Yes, I will require visa sponsorship');
    expect(answer(q('Will you now or in the future require sponsorship?', opts))).toBe('No, I do not require visa sponsorship');
    expect(answer(q('Location and Work Authorization: Are you currently eligible to work in India?', { kind: 'select', options: ['Yes, I am eligible', 'No, I am not'] }))).toBe('Yes, I am eligible');
  });

  it('custom answers win', () => {
    expect(answer(q('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', { kind: 'select', options: ['Yes', 'No'] }))).toBe('Yes');
  });
});
