import { describe, expect, it } from 'vitest';
import { applicationSchema } from '@quarry/shared';
import { degreeFor, disciplineFor, educationFields, educationUrl } from './education.js';

const DEGREES = ["Associate's Degree", "Bachelor's Degree", 'Doctor of Philosophy (Ph.D.)', "Master's Degree", 'Master of Business Administration (M.B.A.)', 'Other'];
const DISCIPLINES = ['Computer Science', 'Data Science', 'Engineering', 'Mathematics', 'Other'];

describe('Greenhouse education block', () => {
  it('maps degrees and disciplines onto the board\'s labels', () => {
    expect(degreeFor('B.Tech, Computer Science and Design', DEGREES)).toBe("Bachelor's Degree");
    expect(degreeFor('M.S. Computer Science', DEGREES)).toBe("Master's Degree");
    expect(degreeFor('MBA', DEGREES)).toBe('Master of Business Administration (M.B.A.)');
    expect(degreeFor('Ph.D. in Physics', DEGREES)).toBe('Doctor of Philosophy (Ph.D.)');
    expect(degreeFor('Diploma', DEGREES)).toBeNull();
    expect(disciplineFor('B.Tech, Computer Science and Design', DISCIPLINES)).toBe('Computer Science');
    expect(disciplineFor('B.A. History', DISCIPLINES)).toBeNull();
  });

  it('fills the block from the profile, falling back to "Other" for a school not on the list', async () => {
    const calls: string[] = [];
    const get = async (u: string) => {
      calls.push(u);
      if (u === educationUrl('acme', 'degrees')) return { items: DEGREES.map((text) => ({ text })) };
      if (u === educationUrl('acme', 'disciplines')) return { items: DISCIPLINES.map((text) => ({ text })) };
      if (u === educationUrl('acme', 'schools', 'Other')) return { items: [{ text: 'Christian Brothers University' }, { text: 'Other' }] };
      return { items: [] };
    };
    const input = {
      applicant: applicationSchema.parse({ university: 'Northfield Institute of Technology', degree: 'B.Tech, Computer Science and Design' }),
      profile: { preferences: { graduation_year: 2027 }, facts: [{ id: 'edu', kind: 'education', content: 'B.Tech at NIT, graduating May 2027.', metrics: { start_year: 2023, end_year: 2027 }, tags: [] }] },
    } as never;
    const fields = await educationFields(get, 'acme', 'education_required', input);
    expect(Object.fromEntries(fields.map((f) => [f.key, f.value]))).toEqual({
      'school--0': 'Other',
      'degree--0': "Bachelor's Degree",
      'discipline--0': 'Computer Science',
      'start-year--0': '2023',
      'end-month--0': 'May',
      'end-year--0': '2027',
    });
    expect(fields.every((f) => f.required && f.selectors[0] === `[id="${f.key}"]`)).toBe(true);
    expect(await educationFields(get, 'acme', 'education_hidden', input)).toEqual([]);
  });
});
