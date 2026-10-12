import { z } from 'zod';
import { idSelector, type ApplicationField, type ApplyInput } from '@quarry/plugin-sdk';

// Greenhouse's Education block (School / Degree / Discipline / start year / end
// month + year). The job API only says whether it's shown (`education`), never
// lists it with the questions, and its choices come from the board's own
// education endpoints. Answers come from the profile's education fact and
// `application.university` / `degree`; anything we can't place stays blank.

const API = 'https://boards-api.greenhouse.io/v1/boards';
const items = z.object({ items: z.array(z.object({ text: z.string() })) });
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const educationUrl = (token: string, list: 'degrees' | 'disciplines' | 'schools', term?: string) =>
  `${API}/${encodeURIComponent(token)}/education/${list}${term ? `?term=${encodeURIComponent(term)}` : ''}`;

/** "B.Tech, Computer Science" → "Bachelor's Degree" (one of the board's degree labels), or null. */
export function degreeFor(text: string, options: string[]): string | null {
  const t = text.toLowerCase();
  const rules: [RegExp, RegExp][] = [
    [/\b(ph\.?\s?d|doctor(ate)? of philosophy)\b/, /ph\.?d/i],
    [/\bm\.?\s?b\.?\s?a\b/, /m\.b\.a|business administration/i],
    [/\b(m\.?\s?tech|m\.?\s?e|m\.?\s?s|m\.?\s?sc|master)/, /^master/i],
    [/\b(b\.?\s?tech|b\.?\s?e|b\.?\s?s|b\.?\s?sc|b\.?\s?a|bachelor)/, /^bachelor/i],
    [/\bassociate/, /^associate/i],
    [/\bhigh school|12th|hsc/, /high school/i],
  ];
  for (const [has, label] of rules) if (has.test(t)) return options.find((o) => label.test(o)) ?? null;
  return null;
}

/** The longest board discipline named in the degree text ("Computer Science and Design" → "Computer Science"). */
export function disciplineFor(text: string, options: string[]): string | null {
  const t = text.toLowerCase();
  return [...options].sort((a, b) => b.length - a.length).find((o) => o !== 'Other' && t.includes(o.toLowerCase())) ?? null;
}

interface EduFacts {
  school: string | null;
  degreeText: string | null;
  startYear: number | null;
  endYear: number | null;
  endMonth: string | null;
}

export function educationFacts(input: Pick<ApplyInput, 'applicant' | 'profile'>): EduFacts {
  const fact = input.profile.facts.find((f) => f.kind === 'education');
  const m = (fact?.metrics ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{4}$/.test(v) ? Number(v) : null);
  const month = fact ? MONTHS.find((mo) => new RegExp(`\\b${mo}\\b`, 'i').test(fact.content)) ?? null : null;
  return {
    school: input.applicant.university,
    degreeText: input.applicant.degree ?? fact?.content ?? null,
    startYear: num(m.start_year),
    endYear: num(m.end_year) ?? input.profile.preferences.graduation_year ?? null,
    endMonth: typeof m.end_month === 'string' ? m.end_month : month,
  };
}

type GetJson = (url: string) => Promise<unknown>;

/** The Education fields for a board whose job says `education_required` / `education_optional`. */
export async function educationFields(getJson: GetJson, token: string, setting: string | null | undefined, input: Pick<ApplyInput, 'applicant' | 'profile'>): Promise<ApplicationField[]> {
  if (setting !== 'education_required' && setting !== 'education_optional') return [];
  const required = setting === 'education_required';
  const e = educationFacts(input);
  const list = async (l: 'degrees' | 'disciplines') => items.parse(await getJson(educationUrl(token, l))).items.map((i) => i.text);
  const [degrees, disciplines] = await Promise.all([list('degrees'), list('disciplines')]);
  let school: string | null = null;
  if (e.school) {
    const found = items.parse(await getJson(educationUrl(token, 'schools', e.school))).items.map((i) => i.text);
    school = found.find((s) => s.toLowerCase() === e.school!.toLowerCase()) ?? null;
    if (!school) school = items.parse(await getJson(educationUrl(token, 'schools', 'Other'))).items.find((i) => i.text === 'Other')?.text ?? null;
  }
  const field = (key: string, label: string, kind: ApplicationField['kind'], value: string | null, options?: string[]): ApplicationField => ({
    key,
    label,
    kind,
    required,
    ...(options ? { options } : {}),
    selectors: [idSelector(key)],
    value,
    source: value ? 'profile' : null,
  });
  return [
    field('school--0', 'School', 'select', school, school ? [school] : undefined),
    field('degree--0', 'Degree', 'select', e.degreeText ? degreeFor(e.degreeText, degrees) : null, degrees),
    field('discipline--0', 'Discipline', 'select', e.degreeText ? disciplineFor(e.degreeText, disciplines) : null, disciplines),
    field('start-year--0', 'Start date year', 'text', e.startYear ? String(e.startYear) : null),
    field('end-month--0', 'End date month', 'select', e.endMonth, MONTHS),
    field('end-year--0', 'End date year', 'text', e.endYear ? String(e.endYear) : null),
  ];
}
