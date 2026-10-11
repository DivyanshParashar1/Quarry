import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { analyzeSheets, normaliseDate, type ColumnClassifier } from './analyze.js';
import { readSpreadsheet, UnsupportedFileError } from './read.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contacts');

/** A real-world-shaped referral sheet: an instructions tab, a title row, merged group headers, messy rows. */
async function messyWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Read me');
  info.addRow(['Please add people who can refer you.']);
  info.addRow(['Keep one person per row.']);

  const ws = wb.addWorksheet('Referrals 2026');
  ws.addRow(['Referral contacts — batch of 2026']);
  ws.mergeCells('A1:G1');
  ws.addRow(['Person', 'Person', 'Work', 'Work', 'Reach', 'Reach', '']);
  ws.mergeCells('A2:B2');
  ws.mergeCells('C2:D2');
  ws.mergeCells('E2:F2');
  ws.addRow(['Name', 'Mail ID', 'Organisation', 'Designation', 'LinkedIn', 'Remarks', 'Batch']);
  ws.addRow(['SHARMA, RAHUL', 'rahul.sharma@acme.com', 'Acme Payments', 'SDE 2', null, 'college senior', '2019']);
  ws.addRow(['Priya Kapoor', 'Priya <PRIYA.K@globex.com>', 'Globex', 'Staff Engineer', null, '', '2018']);
  ws.addRow(['Ankit', 'ankit at initech dot com', 'Initech', 'Recruiter', null, 'met at a meetup', '']);
  ws.addRow([]);
  ws.addRow(['Rahul Sharma', '', 'Acme Payments', 'SDE II', null, '', '2019']); // same person, no email
  ws.addRow(['Meera Iyer', '', '', 'Freelancer', null, '', '']); // no company
  ws.addRow(['Dev Patel', '', 'Globex', 'ML Engineer', null, '', '2021']);
  // LinkedIn column holds hyperlinks whose visible text is just "Profile".
  ws.getCell('E4').value = { text: 'Profile', hyperlink: 'https://www.linkedin.com/in/rahul-sharma-acme/' };
  ws.getCell('E8').value = { text: 'Profile', hyperlink: 'https://www.linkedin.com/in/rahul-sharma-acme/' };
  ws.getCell('E10').value = { text: 'Profile', hyperlink: 'https://in.linkedin.com/in/DevPatel?trk=x' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readSpreadsheet', () => {
  it('reads every sheet, filling merged ranges and resolving hyperlinks', async () => {
    const sheets = await readSpreadsheet(await messyWorkbook(), 'referrals.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['Read me', 'Referrals 2026']);
    const rows = sheets[1]!.rows;
    expect(rows[0]![6]).toBe('Referral contacts — batch of 2026'); // merged across A1:G1
    expect(rows[1]!.slice(0, 4)).toEqual(['Person', 'Person', 'Work', 'Work']);
    expect(rows[3]![4]).toBe('https://www.linkedin.com/in/rahul-sharma-acme/');
    expect(sheets[1]!.merged.length).toBe(4);
  });

  it('rejects .xls with a Save-As hint', async () => {
    await expect(readSpreadsheet(Buffer.from('x'), 'old.xls')).rejects.toThrow(UnsupportedFileError);
    await expect(readSpreadsheet(Buffer.from('x'), 'old.xls')).rejects.toThrow(/Save As \.xlsx/);
  });
});

describe('analyzeSheets: messy Excel', () => {
  it('finds the right sheet and header, maps columns, normalises, dedupes, and reports', async () => {
    const asked: string[] = [];
    const classify: ColumnClassifier = async (cols) => {
      asked.push(...cols.map((c) => c.header));
      return cols.map((c) => ({ index: c.index, type: 'notes' as const }));
    };
    const { report, rows } = await analyzeSheets(await readSpreadsheet(await messyWorkbook(), 'referrals.xlsx'), { classify });

    expect(report.format).toBe('generic');
    expect(report.sheet).toBe('Referrals 2026');
    expect(report.headerRow).toBe(3);
    expect(report.groupHeaderRows).toEqual([2]);
    const types = Object.fromEntries(report.columns.map((c) => [c.header, [c.type, c.via]]));
    expect(types).toMatchObject({
      Name: ['full_name', 'header'],
      'Mail ID': ['email', 'header'],
      Organisation: ['company', 'header'],
      Designation: ['title', 'header'],
      LinkedIn: ['linkedin_url', 'header'],
      Remarks: ['notes', 'header'],
      Batch: ['notes', 'llm'],
    });
    // Only the unrecognised column went to the classifier.
    expect(asked).toEqual(['Batch']);

    expect(report.rows).toEqual({ total: 6, importable: 4, skipped: 2 });
    expect(report.duplicates).toEqual({ byLinkedin: 1, byEmail: 0, byNameCompany: 0 });
    expect(report.invalidEmails).toEqual({ count: 1, examples: ['ankit at initech dot com'] });
    expect(report.nameFormats).toMatchObject({ lastCommaFirst: 1, singleWord: 1, allCaps: 1 });
    expect(report.missing.company).toBe(1);
    expect(report.companies.top).toEqual([{ name: 'Globex', count: 2 }, { name: 'Acme Payments', count: 1 }, { name: 'Initech', count: 1 }]);

    const rahul = rows.find((r) => r.line === 4)!;
    expect(rahul).toMatchObject({
      name: 'Rahul Sharma',
      email: 'rahul.sharma@acme.com',
      linkedinUrl: 'https://www.linkedin.com/in/rahul-sharma-acme/',
      company: 'Acme Payments',
      action: 'import',
    });
    expect(rahul.fixes).toEqual(expect.arrayContaining(['reordered "Last, First"', 'title-cased name', 'merged duplicate row 8']));
    expect(rahul.notes).toBe('college senior · 2019');
    expect(rows.find((r) => r.line === 8)).toMatchObject({ action: 'skip', problems: ['duplicate of row 4'] });
    expect(rows.find((r) => r.line === 5)!.email).toBe('priya.k@globex.com');
    expect(rows.find((r) => r.line === 6)).toMatchObject({ email: null, action: 'import', problems: ['invalid email "ankit at initech dot com"'] });
    expect(rows.find((r) => r.name === 'Meera Iyer')).toMatchObject({ action: 'skip' });
    expect(rows.find((r) => r.name === 'Dev Patel')!.linkedinUrl).toBe('https://www.linkedin.com/in/devpatel/');
    expect(report.warnings).toEqual([]);
  });

  it('without a classifier, an unknown column is ignored with a warning', async () => {
    const { report } = await analyzeSheets(await readSpreadsheet(await messyWorkbook(), 'referrals.xlsx'));
    expect(report.columns.find((c) => c.header === 'Batch')).toMatchObject({ type: 'ignore', via: 'none' });
    expect(report.warnings).toContain('column "Batch" not recognised; ignored');
  });
});

describe('analyzeSheets: LinkedIn Connections export', () => {
  it('recognises the export, skips its preamble, and normalises dates', async () => {
    const data = await readFile(join(FIX, 'Connections.csv'));
    const { report, rows } = await analyzeSheets(await readSpreadsheet(data, 'Connections.csv'));
    expect(report.format).toBe('linkedin_connections');
    expect(report.headerRow).toBe(4);
    expect(report.rows).toEqual({ total: 5, importable: 3, skipped: 2 });
    expect(report.duplicates.byLinkedin).toBe(1);
    expect(report.warnings).toContain('LinkedIn Connections export: everyone is recorded as a 1st-degree connection');
    expect(rows[0]).toMatchObject({
      name: 'Aarav Mehta',
      linkedinUrl: 'https://www.linkedin.com/in/aarav-mehta-12ab34/',
      company: 'Acme Payments',
      title: 'Software Engineer II',
      connectedOn: '2024-03-05',
      email: null,
    });
    expect(rows.find((r) => r.name === 'Isha Verma')!.email).toBe('isha.verma@example.com');
    expect(rows.find((r) => r.name === 'Neha')).toMatchObject({ action: 'skip', problems: ['no company (contacts belong to a company)'] });
  });
});

describe('normaliseDate', () => {
  it('reads the formats contact sheets use', () => {
    expect(normaliseDate('05 Mar 2024')).toBe('2024-03-05');
    expect(normaliseDate('5-Mar-24')).toBe('2024-03-05');
    expect(normaliseDate('2025-01-17')).toBe('2025-01-17');
    expect(normaliseDate('17/1/2025')).toBe('2025-01-17');
    expect(normaliseDate('last spring')).toBeNull();
  });
});
