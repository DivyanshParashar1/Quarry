import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv.js';
import { parseCompaniesCsv } from './companies.js';
import { table } from './format.js';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM', () => {
    const text = '\uFEFFa,b,c\r\n"x, y","say ""hi""","multi\nline"\r\n\r\n1,,3';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'multi\nline'],
      ['1', '', '3'],
    ]);
  });
  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });
});

describe('parseCompaniesCsv', () => {
  it('parses rows, splits tags, and reports invalid rows by line', () => {
    const { rows, errors } = parseCompaniesCsv(
      [
        'Name,ATS_Type,Board_Token,Tags,Domain',
        'Acme,greenhouse,acme,startup; fintech,acme.com',
        'NoBoard,lever,,,',
        'Bad,icims,x,,',
        ',greenhouse,y,,',
        'Plain,,,,',
      ].join('\n'),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Acme',
      ats_type: 'greenhouse',
      board_token: 'acme',
      tags: ['startup', 'fintech'],
      domain: 'acme.com',
    });
    expect(rows[1]).toMatchObject({ name: 'Plain', tags: [] });
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^line 3: board_token/);
    expect(errors[1]).toMatch(/^line 4: ats_type/);
    expect(errors[2]).toMatch(/^line 5: name/);
  });
});

describe('parseCompaniesCsv (Phase 6 columns)', () => {
  it('folds workday_tenant/site and smartrecruiters_company_id into ats_type + board_token', () => {
    const { rows, errors } = parseCompaniesCsv(
      [
        'name,ats_type,board_token,workday_tenant,workday_site,smartrecruiters_company_id',
        'Walmart Global Tech,,,walmart.wd5,WalmartExternal,',
        'NVIDIA,workday,https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite,,,',
        'Visa,,,,,Visa',
        'Broken,,,walmart,,',
      ].join('\n'),
    );
    expect(rows.map((r) => [r.name, r.ats_type, r.board_token])).toEqual([
      ['Walmart Global Tech', 'workday', 'walmart.wd5/WalmartExternal'],
      ['NVIDIA', 'workday', 'nvidia.wd5/NVIDIAExternalCareerSite'],
      ['Visa', 'smartrecruiters', 'Visa'],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^line 5: workday_tenant: invalid Workday board token/);
  });
});

describe('table', () => {
  it('pads columns and truncates long values', () => {
    const out = table([{ a: 'x', b: 'long value here' }], [
      { header: 'A', value: (r) => r.a },
      { header: 'B', value: (r) => r.b, max: 6 },
    ]);
    expect(out.split('\n')).toEqual(['A  B', '-  ------', 'x  long …']);
  });
});
