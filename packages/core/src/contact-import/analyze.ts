import { canonicalProfileUrl } from '@jobforge/plugin-sdk';
import type { SheetGrid } from './read.js';

// Deterministic contact-sheet analysis: find the header row, classify each
// column from its header and its values, normalise every row, de-duplicate,
// and describe the file (the EDA report). An LLM is only asked about columns
// these heuristics can't classify (see `classifyUnknown`).

export const COLUMN_TYPES = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'linkedin_url',
  'company',
  'title',
  'phone',
  'location',
  'connected_on',
  'notes',
  'ignore',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

const HEADER_SYNONYMS: Array<[ColumnType, RegExp]> = [
  ['first_name', /^(first|given|fore)[ _-]?name$|^first$|^fname$/i],
  ['last_name', /^(last|family|sur)[ _-]?name$|^last$|^lname$|^surname$/i],
  ['full_name', /^(full[ _-]?)?name$|^(contact|person|employee|referrer|alumni?|alumnus)( name)?$|^name of (the )?(person|contact|employee|referrer)$/i],
  ['email', /e-?mail|mail id|email address/i],
  ['linkedin_url', /linked[ -]?in|profile (url|link)|^url$|^profile$/i],
  ['company', /^(current )?(company|organi[sz]ation|employer|firm|org)( name)?$|works? at|^company\b/i],
  ['title', /^(job )?(title|position|designation|role)$|^current (role|title|position)$|^position\b|^designation\b/i],
  ['phone', /phone|mobile|contact (no|number)|whats ?app|^cell/i],
  ['location', /^(location|city|country|place|based in|base location)$/i],
  ['connected_on', /connected on|connected since|date connected/i],
  ['notes', /^(notes?|remarks?|comments?|how (i|we) know|relationship|context)$/i],
];

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;
const LINKEDIN_RE = /linkedin\.com\/in\//i;
const PHONE_RE = /^\+?[\d\s().-]{8,}$/;
const DATE_RE = /^(\d{1,2}[ -/][A-Za-z]{3}[ -/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

export interface ColumnReport {
  index: number;
  header: string;
  type: ColumnType;
  /** How the type was decided. */
  via: 'header' | 'values' | 'llm' | 'none';
  fillRate: number;
  distinct: number;
  sample: string[];
}

export interface ImportRow {
  /** 1-based row in the sheet. */
  line: number;
  name: string;
  email: string | null;
  linkedinUrl: string | null;
  company: string | null;
  title: string | null;
  phone: string | null;
  location: string | null;
  connectedOn: string | null;
  notes: string | null;
  /** What was changed while normalising ("split Last, First", "lowercased email"). */
  fixes: string[];
  /** Why the row can't be imported as-is. */
  problems: string[];
  action: 'import' | 'skip';
}

export type SheetFormat = 'linkedin_connections' | 'generic';

export interface EdaReport {
  format: SheetFormat;
  sheets: Array<{ name: string; rows: number; columns: number; mergedRanges: number }>;
  sheet: string;
  /** 1-based. */
  headerRow: number;
  /** Rows above the header that were treated as a merged group header (combined into column names). */
  groupHeaderRows: number[];
  columns: ColumnReport[];
  rows: { total: number; importable: number; skipped: number };
  duplicates: { byLinkedin: number; byEmail: number; byNameCompany: number };
  invalidEmails: { count: number; examples: string[] };
  nameFormats: { firstLast: number; lastCommaFirst: number; singleWord: number; allCaps: number; splitColumns: number };
  missing: { company: number; email: number; linkedin: number; reachable: number };
  companies: { distinct: number; top: Array<{ name: string; count: number }> };
  warnings: string[];
}

export interface AnalyzeResult {
  report: EdaReport;
  rows: ImportRow[];
}

/** An optional classifier for columns the heuristics can't place (LLM-backed in practice). */
export type ColumnClassifier = (cols: Array<{ index: number; header: string; sample: string[] }>) => Promise<Array<{ index: number; type: ColumnType }>>;

const LINKEDIN_EXPORT_HEADERS = ['first name', 'last name', 'url', 'email address', 'company', 'position', 'connected on'];

export function isLinkedInExport(headers: string[]): boolean {
  const h = headers.map((x) => x.trim().toLowerCase());
  return LINKEDIN_EXPORT_HEADERS.filter((x) => h.includes(x)).length >= 5;
}

/** The best sheet: the one with the most rows whose detected header looks like a contact list. */
export function pickSheet(sheets: SheetGrid[]): SheetGrid {
  let best = sheets[0]!;
  let bestScore = -1;
  for (const s of sheets) {
    const { row } = detectHeader(s.rows);
    const header = s.rows[row] ?? [];
    const score = header.filter((h) => headerType(h)).length * 1000 + s.rows.length;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** Header = the row (in the first 20) with the most cells that read like contact-sheet column names. */
export function detectHeader(rows: string[][]): { row: number; groupRows: number[] } {
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i] ?? [];
    const nonEmpty = r.filter(Boolean);
    if (nonEmpty.length < 2) continue;
    const known = nonEmpty.filter((c) => headerType(c)).length;
    const valueLike = nonEmpty.filter((c) => EMAIL_RE.test(c) || LINKEDIN_RE.test(c) || /^\d/.test(c)).length;
    const score = known * 10 + nonEmpty.length - valueLike * 8;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  // A row right above with few distinct values repeated across columns = a merged group header.
  const groupRows: number[] = [];
  const above = rows[best - 1];
  if (above && above.filter(Boolean).length >= 2) {
    const distinct = new Set(above.filter(Boolean));
    if (distinct.size < above.filter(Boolean).length) groupRows.push(best - 1);
  }
  return { row: best, groupRows };
}

function headerType(h: string): ColumnType | null {
  const t = h.trim();
  if (!t || t.length > 60) return null;
  for (const [type, re] of HEADER_SYNONYMS) if (re.test(t)) return type;
  return null;
}

function valueType(values: string[]): ColumnType | null {
  const v = values.filter(Boolean);
  if (!v.length) return null;
  const share = (re: RegExp) => v.filter((x) => re.test(x)).length / v.length;
  if (share(LINKEDIN_RE) >= 0.5) return 'linkedin_url';
  if (share(/@/) >= 0.5) return 'email';
  if (share(DATE_RE) >= 0.6) return 'connected_on';
  if (share(PHONE_RE) >= 0.6) return 'phone';
  return null;
}

export async function analyzeSheets(sheets: SheetGrid[], opts: { classify?: ColumnClassifier } = {}): Promise<AnalyzeResult> {
  if (!sheets.length) throw new Error('the file has no sheets');
  const sheet = pickSheet(sheets);
  const { row: headerIdx, groupRows } = detectHeader(sheet.rows);
  const rawHeader = sheet.rows[headerIdx] ?? [];
  const width = Math.max(rawHeader.length, ...sheet.rows.slice(headerIdx + 1).map((r) => r.length));
  const group = groupRows.length ? sheet.rows[groupRows[0]!] ?? [] : [];
  const headers = Array.from({ length: width }, (_, i) => {
    const h = rawHeader[i] ?? '';
    const g = group[i] ?? '';
    return g && g !== h && !h ? g : h;
  });
  const bodyAll = sheet.rows.slice(headerIdx + 1).map((r, i) => ({ r, line: headerIdx + 2 + i }));
  const bodyLines = bodyAll.filter((x) => x.r.some(Boolean));
  const body = bodyLines.map((x) => x.r);
  const format: SheetFormat = isLinkedInExport(headers) ? 'linkedin_connections' : 'generic';

  // Classify columns.
  const columns: ColumnReport[] = headers.map((header, index) => {
    const values = body.map((r) => r[index] ?? '');
    const filled = values.filter(Boolean);
    let type: ColumnType | null = format === 'linkedin_connections' ? linkedinExportType(header) : headerType(header);
    let via: ColumnReport['via'] = type ? 'header' : 'none';
    const byValue = valueType(values);
    // Values beat a vague header ("Profile" full of emails), but not a specific one.
    if (byValue && (!type || ((type === 'notes' || type === 'full_name') && byValue !== type))) {
      type = byValue;
      via = 'values';
    }
    return {
      index,
      header,
      type: type ?? 'ignore',
      via,
      fillRate: body.length ? Math.round((filled.length / body.length) * 100) / 100 : 0,
      distinct: new Set(filled.map((x) => x.toLowerCase())).size,
      sample: [...new Set(filled)].slice(0, 5),
    };
  });

  const unknown = columns.filter((c) => c.via === 'none' && c.fillRate > 0);
  if (unknown.length && opts.classify) {
    const answers = await opts.classify(unknown.map((c) => ({ index: c.index, header: c.header, sample: c.sample })));
    for (const a of answers) {
      const col = columns.find((c) => c.index === a.index);
      if (col && col.via === 'none' && (COLUMN_TYPES as readonly string[]).includes(a.type)) {
        col.type = a.type;
        col.via = 'llm';
      }
    }
  }
  // Only the first column of each type is used (except notes, which are joined).
  const firstOf = (t: ColumnType) => columns.find((c) => c.type === t)?.index;
  const warnings: string[] = [];
  for (const t of COLUMN_TYPES) {
    if (t === 'ignore' || t === 'notes') continue;
    const n = columns.filter((c) => c.type === t).length;
    if (n > 1) warnings.push(`${n} columns look like ${t}; using "${columns.find((c) => c.type === t)!.header}"`);
  }
  for (const c of columns) if (c.via === 'none' && c.fillRate > 0) warnings.push(`column "${c.header || `#${c.index + 1}`}" not recognised; ignored`);

  const get = (r: string[], t: ColumnType) => {
    const i = firstOf(t);
    return i === undefined ? '' : (r[i] ?? '').trim();
  };
  const noteCols = columns.filter((c) => c.type === 'notes').map((c) => c.index);

  const nameFormats = { firstLast: 0, lastCommaFirst: 0, singleWord: 0, allCaps: 0, splitColumns: 0 };
  let invalidCount = 0;
  const invalidExamples: string[] = [];
  const rows: ImportRow[] = body.map((r, i) => {
    const fixes: string[] = [];
    const problems: string[] = [];
    // Name.
    let name = '';
    const first = get(r, 'first_name');
    const last = get(r, 'last_name');
    if (first || last) {
      name = `${first} ${last}`.trim();
      nameFormats.splitColumns++;
    } else {
      name = get(r, 'full_name');
      if (/^[^,]+,\s*[^,]+$/.test(name)) {
        const [l, f] = name.split(',').map((x) => x.trim());
        name = `${f} ${l}`;
        nameFormats.lastCommaFirst++;
        fixes.push('reordered "Last, First"');
      } else if (name && !name.includes(' ')) nameFormats.singleWord++;
      else if (name) nameFormats.firstLast++;
    }
    if (name && name === name.toUpperCase() && /[A-Z]{2}/.test(name)) {
      nameFormats.allCaps++;
      name = titleCase(name);
      fixes.push('title-cased name');
    }
    name = name.replace(/\s+/g, ' ').trim();

    // Email: first valid address in the cell.
    const rawEmail = get(r, 'email');
    let email: string | null = null;
    if (rawEmail) {
      const found = rawEmail.split(/[\s,;/]+/).map((x) => x.replace(/^mailto:/i, '').replace(/[<>]/g, '')).find((x) => EMAIL_RE.test(x));
      if (found) {
        email = found.toLowerCase();
        if (found !== rawEmail) fixes.push('cleaned email');
      } else {
        invalidCount++;
        if (invalidExamples.length < 5) invalidExamples.push(rawEmail);
        problems.push(`invalid email "${rawEmail}"`);
      }
    }
    // LinkedIn.
    const rawUrl = get(r, 'linkedin_url') || r.find((c) => LINKEDIN_RE.test(c)) || '';
    let linkedinUrl: string | null = null;
    if (rawUrl) {
      linkedinUrl = canonicalProfileUrl(/^https?:/i.test(rawUrl) ? rawUrl : `https://${rawUrl.replace(/^\/+/, '')}`);
      if (!linkedinUrl) problems.push(`not a LinkedIn profile URL "${rawUrl}"`);
    }
    const company = get(r, 'company') || null;
    const notes = noteCols.map((ci) => (r[ci] ?? '').trim()).filter(Boolean).join(' · ') || null;
    if (!name) problems.push('no name');
    if (!company) problems.push('no company (contacts belong to a company)');
    const action: ImportRow['action'] = name && company ? 'import' : 'skip';
    return {
      line: bodyLines[i]!.line,
      name,
      email,
      linkedinUrl,
      company,
      title: get(r, 'title') || null,
      phone: get(r, 'phone') || null,
      location: get(r, 'location') || null,
      connectedOn: normaliseDate(get(r, 'connected_on')),
      notes,
      fixes,
      problems,
      action,
    };
  });

  const deduped = dedupe(rows);
  const importable = deduped.rows.filter((r) => r.action === 'import');
  const companyCounts = new Map<string, number>();
  for (const r of importable) companyCounts.set(r.company!, (companyCounts.get(r.company!) ?? 0) + 1);
  if (format === 'linkedin_connections') warnings.push('LinkedIn Connections export: everyone is recorded as a 1st-degree connection');

  return {
    rows: deduped.rows,
    report: {
      format,
      sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.filter((r) => r.some(Boolean)).length, columns: Math.max(0, ...s.rows.map((r) => r.length)), mergedRanges: s.merged.length })),
      sheet: sheet.name,
      headerRow: headerIdx + 1,
      groupHeaderRows: groupRows.map((g) => g + 1),
      columns,
      rows: { total: rows.length, importable: importable.length, skipped: deduped.rows.length - importable.length },
      duplicates: deduped.counts,
      invalidEmails: { count: invalidCount, examples: invalidExamples },
      nameFormats,
      missing: {
        company: rows.filter((r) => !r.company).length,
        email: rows.filter((r) => !r.email).length,
        linkedin: rows.filter((r) => !r.linkedinUrl).length,
        reachable: importable.filter((r) => !r.email && !r.linkedinUrl).length,
      },
      companies: {
        distinct: companyCounts.size,
        top: [...companyCounts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
      },
      warnings,
    },
  };
}

function linkedinExportType(h: string): ColumnType | null {
  const map: Record<string, ColumnType> = {
    'first name': 'first_name',
    'last name': 'last_name',
    url: 'linkedin_url',
    'email address': 'email',
    company: 'company',
    position: 'title',
    'connected on': 'connected_on',
  };
  return map[h.trim().toLowerCase()] ?? null;
}

/** Merge rows that are the same person (LinkedIn URL, then email, then name + company); later rows fill gaps. */
export function dedupe(rows: ImportRow[]): { rows: ImportRow[]; counts: EdaReport['duplicates'] } {
  const counts = { byLinkedin: 0, byEmail: 0, byNameCompany: 0 };
  const out: ImportRow[] = [];
  const byUrl = new Map<string, ImportRow>();
  const byEmail = new Map<string, ImportRow>();
  const byNameCo = new Map<string, ImportRow>();
  for (const r of rows) {
    if (r.action === 'skip') {
      out.push(r);
      continue;
    }
    const nameCo = `${r.name.toLowerCase()}|${r.company!.toLowerCase()}`;
    let into: ImportRow | undefined;
    if (r.linkedinUrl && byUrl.has(r.linkedinUrl)) {
      into = byUrl.get(r.linkedinUrl);
      counts.byLinkedin++;
    } else if (r.email && byEmail.has(r.email)) {
      into = byEmail.get(r.email);
      counts.byEmail++;
    } else if (byNameCo.has(nameCo) && !(r.linkedinUrl && byNameCo.get(nameCo)!.linkedinUrl && byNameCo.get(nameCo)!.linkedinUrl !== r.linkedinUrl)) {
      into = byNameCo.get(nameCo);
      counts.byNameCompany++;
    }
    if (into) {
      for (const k of ['email', 'linkedinUrl', 'title', 'phone', 'location', 'connectedOn', 'notes'] as const) into[k] ??= r[k];
      into.fixes.push(`merged duplicate row ${r.line}`);
      r.action = 'skip';
      r.problems.push(`duplicate of row ${into.line}`);
      out.push(r);
    } else {
      out.push(r);
    }
    const target = into ?? r;
    if (target.linkedinUrl) byUrl.set(target.linkedinUrl, target);
    if (target.email) byEmail.set(target.email, target);
    byNameCo.set(`${target.name.toLowerCase()}|${target.company!.toLowerCase()}`, target);
  }
  return { rows: out, counts };
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "05 Mar 2024" (LinkedIn export) / "2024-03-05" / "5/3/2024" (day first) → "2024-03-05". */
export function normaliseDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})[ -/]([A-Za-z]{3})[A-Za-z]*[ -/](\d{2,4})$/);
  if (m && MONTHS[m[2]!.toLowerCase()]) return `${m[3]!.length === 2 ? `20${m[3]}` : m[3]}-${MONTHS[m[2]!.toLowerCase()]}-${m[1]!.padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return null;
}
