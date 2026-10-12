import { describe, expect, it } from 'vitest';
import { applicationSchema } from '@quarry/shared';
import { applicationDraftSchema, fillForm, idSelector, mapAnswers, type ApplyInput, type FormQuestion } from './apply.js';
import { fakeBrowser } from './testing.js';

const applicant = applicationSchema.parse({
  location: 'Bengaluru, India',
  current_company: 'Hooli',
  current_title: 'Founding Engineer Intern',
  work_authorization: { India: 'yes', US: 'no' },
  requires_sponsorship: false,
  answers: [{ match: 'WhatsApp', answer: 'Yes' }],
});
const input = {
  applicant,
  profile: { preferences: { graduation_year: null }, facts: [{ id: 'edu', kind: 'education', content: 'B.Tech', metrics: { cpi: 8.17 }, tags: [] }] },
  resume: { path: '/r.pdf', resumeVariantId: null },
} as unknown as ApplyInput;
const q = (label: string, o: Partial<FormQuestion> = {}): FormQuestion => ({ key: label, label, kind: 'text', required: true, selectors: [], ...o });
const answer = (question: FormQuestion) => mapAnswers([question], input).fields[0]!.value;

describe('mapAnswers', () => {
  it('current or previous employer / title, and country of residence', () => {
    expect(answer(q('Who is your current or previous employer?'))).toBe('Hooli');
    expect(answer(q('What is your current or previous job title?'))).toBe('Founding Engineer Intern');
    expect(answer(q('Most recent company'))).toBe('Hooli');
    expect(answer(q('Please select the country where you currently reside.', { kind: 'select', options: ['India', 'US', 'Other'] }))).toBe('India');
  });

  it('sponsorship follows the country named in the question', () => {
    const opts = { kind: 'select' as const, options: ['Yes, I will require visa sponsorship', 'No, I do not require visa sponsorship'] };
    expect(answer(q('Do you require visa sponsorship to continue working in India?', opts))).toBe('No, I do not require visa sponsorship');
    expect(answer(q('Will you require sponsorship to work in the US?', opts))).toBe('Yes, I will require visa sponsorship');
    expect(answer(q('Will you now or in the future require sponsorship?', opts))).toBe('No, I do not require visa sponsorship');
    expect(answer(q('Location and Work Authorization: Are you currently eligible to work in India?', { kind: 'select', options: ['Yes, I am eligible', 'No, I am not'] }))).toBe('Yes, I am eligible');
  });

  it('GPA questions get the education fact\'s GPA/CPI, not the degree', () => {
    expect(answer(q('As part of our commitment to understanding candidates, share your GPA alongside your other qualifications.', { required: false }))).toBe('8.17');
  });

  it('custom answers win', () => {
    expect(answer(q('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?', { kind: 'select', options: ['Yes', 'No'] }))).toBe('Yes');
  });
});

// Greenhouse's newer (react) form: comboboxes, checkbox groups, a Google-backed location box.
const NEW_FORM = `
<input id="first_name" type="text"/>
<input class="select__input" id="question_1" role="combobox"/><div id="react-select-question_1-placeholder">Select...</div>
<fieldset class="checkbox" id="question_2[]">
  <input type="checkbox" id="question_2[]_10" name="question_2[]" value="10"/><label for="question_2[]_10">January to June (6 months)</label>
  <input type="checkbox" id="question_2[]_11" name="question_2[]" value="11"/><label for="question_2[]_11">May to July (10 weeks)</label>
</fieldset>
<input class="select__input" id="candidate-location" role="combobox"/><div id="react-select-candidate-location-placeholder"></div>`;

describe('fillForm on react forms', () => {
  it('picks combobox options by position, ticks the matching checkbox, and takes the first location suggestion', async () => {
    let html = NEW_FORM;
    const site = fakeBrowser({
      pages: { 'https://form': () => html },
      onClick: (sel) => {
        // Opening a combobox renders its menu.
        // Filtering keeps unfiltered ids: typing "No" leaves only option-1.
        if (sel === idSelector('question_1')) return { html: (html += '<div id="react-select-question_1-option-1">No</div>') };
        if (sel === idSelector('candidate-location')) return { html: (html += '<div id="react-select-candidate-location-option-0">Bengaluru, Karnataka, India</div>') };
        return undefined;
      },
    });
    const page = await site.newPage();
    await page.goto('https://form');
    const field = (key: string, kind: string, value: string, o: Record<string, unknown> = {}) => ({ key, label: key, kind, required: true, value, source: 'profile', selectors: [idSelector(key)], ...o });
    const draft = applicationDraftSchema.parse({
      channel: 'apply', ats: 'greenhouse', title: 'SWE Intern', company: 'Acme', jobUrl: 'https://j', applyUrl: 'https://form', resumePath: '/r.pdf', resumeVariantId: null,
      fields: [
        field('first_name', 'text', 'Asha'),
        field('question_1', 'select', 'No', { options: ['Yes', 'No'] }),
        field('question_2[]', 'multiselect', 'May to July (10 weeks)', { options: ['January to June (6 months)', 'May to July (10 weeks)'] }),
        field('location', 'text', 'Bengaluru, India', { selectors: [idSelector('location'), idSelector('candidate-location')] }),
      ],
      missingRequired: [], confidence: 1,
    });
    expect(await fillForm(page as never, draft)).toEqual([]);
    const acts = site.actions.map((a) => `${a.type} ${a.selector ?? ''}`);
    expect(acts).toContain(`fill ${idSelector('first_name')}`);
    expect(acts).toContain(`click ${idSelector('react-select-question_1-option-1')}`);
    expect(acts).toContain(`check ${idSelector('question_2[]_11')}`);
    expect(acts).toContain(`click ${idSelector('react-select-candidate-location-option-0')}`);
    expect(acts.some((a) => a.startsWith('select '))).toBe(false);
  });
});
