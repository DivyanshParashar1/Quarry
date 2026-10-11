import { z } from 'zod';
import {
  AmbiguousContactError,
  appendEvent,
  createContactImport,
  finishContactImport,
  getContactImport,
  listCompaniesForMatching,
  setContactImportFields,
  upsertCompany,
  upsertContact,
  type ContactImportRow,
  type DB,
} from '@jobforge/db';
import type { LLMClient } from '@jobforge/shared';
import { normalizeCompanyName } from '../normalize.js';
import { analyzeSheets, COLUMN_TYPES, type ColumnClassifier, type EdaReport, type ImportRow } from './analyze.js';
import { readSpreadsheet } from './read.js';

export * from './analyze.js';
export * from './read.js';

// Phase 17 contact import: upload → analyse (EDA, mapping, normalisation) →
// preview stored in contact_imports → the user confirms → contacts written.
// Imported people rank first in referral fan-out; rows from LinkedIn's
// Connections export are recorded as 1st-degree connections.

export const IMPORT_SOURCE = { linkedin_connections: 'linkedin_export', generic: 'manual_import' } as const;
export const IMPORTED_SOURCES: string[] = Object.values(IMPORT_SOURCE);

const FREE_MAIL = /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|proton(mail)?|rediffmail|aol)\./i;

export interface CompanyMatch {
  name: string;
  /** Existing company, or null = will be created. */
  companyId: string | null;
  matchedName: string | null;
  via: 'name' | 'email_domain' | null;
  rows: number;
}

export interface ImportPreview {
  importId: string;
  filename: string;
  report: EdaReport;
  companies: CompanyMatch[];
  /** First rows, normalised, for the preview table. */
  sample: ImportRow[];
  problems: ImportRow[];
}

/** LLM fallback for columns the heuristics can't classify: header + up to 5 sample values only. */
export function llmColumnClassifier(llm: LLMClient, signal?: AbortSignal): ColumnClassifier {
  const schema = z.object({ columns: z.array(z.object({ index: z.number().int(), type: z.enum(COLUMN_TYPES) })) });
  return async (cols) => {
    const res = await llm.generate({
      task: 'extract',
      system:
        'You classify spreadsheet columns of a contact list. For each column pick one type: ' +
        `${COLUMN_TYPES.join(', ')}. Use "ignore" when it is none of them. Answer only from the header and sample values.`,
      prompt: cols.map((c) => `- index ${c.index}: header "${c.header}" · samples: ${c.sample.map((s) => JSON.stringify(s.slice(0, 60))).join(', ')}`).join('\n'),
      schema,
      maxTokens: 400,
      ...(signal ? { signal } : {}),
    });
    return res.data.columns;
  };
}

export async function previewContactImport(
  db: DB,
  file: { data: Uint8Array | Buffer; filename: string },
  opts: { classify?: ColumnClassifier } = {},
): Promise<ImportPreview> {
  const sheets = await readSpreadsheet(file.data, file.filename);
  const { report, rows } = await analyzeSheets(sheets, opts);
  const companies = await matchCompanies(db, rows);
  const row = await createContactImport(db, { filename: file.filename, format: report.format, report: { ...report, companyMatches: companies }, rows });
  return toPreview(row.id, file.filename, report, companies, rows);
}

function toPreview(importId: string, filename: string, report: EdaReport, companies: CompanyMatch[], rows: ImportRow[]): ImportPreview {
  return {
    importId,
    filename,
    report,
    companies,
    sample: rows.filter((r) => r.action === 'import').slice(0, 25),
    problems: rows.filter((r) => r.problems.length).slice(0, 100),
  };
}

export async function getImportPreview(db: DB, id: string): Promise<ImportPreview | null> {
  const imp = await getContactImport(db, id);
  if (!imp) return null;
  const report = imp.report as EdaReport & { companyMatches: CompanyMatch[] };
  return toPreview(imp.id, imp.filename, report, report.companyMatches ?? [], imp.rows as ImportRow[]);
}

/** Imported company names → existing companies (normalised name, then work-email domain); the rest are new. */
export async function matchCompanies(db: DB, rows: ImportRow[]): Promise<CompanyMatch[]> {
  const all = await listCompaniesForMatching(db);
  const byName = new Map(all.map((c) => [normalizeCompanyName(c.name), c]));
  const byDomain = new Map(all.filter((c) => c.domain).map((c) => [c.domain!.toLowerCase().replace(/^www\./, ''), c]));
  const out = new Map<string, CompanyMatch>();
  for (const r of rows) {
    if (r.action !== 'import' || !r.company) continue;
    const key = normalizeCompanyName(r.company);
    const m = out.get(key);
    if (m) {
      m.rows++;
      if (!m.companyId && r.email && !FREE_MAIL.test(r.email)) Object.assign(m, domainMatch(byDomain, r.email) ?? {});
      continue;
    }
    const hit = byName.get(key);
    const d = !hit && r.email && !FREE_MAIL.test(r.email) ? domainMatch(byDomain, r.email) : null;
    out.set(key, {
      name: r.company,
      companyId: hit?.id ?? d?.companyId ?? null,
      matchedName: hit?.name ?? d?.matchedName ?? null,
      via: hit ? 'name' : d ? 'email_domain' : null,
      rows: 1,
    });
  }
  return [...out.values()].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
}

function domainMatch(byDomain: Map<string, { id: string; name: string }>, email: string): Pick<CompanyMatch, 'companyId' | 'matchedName' | 'via'> | null {
  const domain = email.split('@')[1]!.toLowerCase();
  const hit = byDomain.get(domain) ?? byDomain.get(domain.split('.').slice(-2).join('.'));
  return hit ? { companyId: hit.id, matchedName: hit.name, via: 'email_domain' } : null;
}

export interface ImportResult {
  contactsCreated: number;
  contactsUpdated: number;
  companiesCreated: number;
  skipped: Array<{ line: number; reason: string }>;
}

export class ContactImportError extends Error {}

/** Write a previewed import. Idempotent per import (a second commit is refused). */
export async function commitContactImport(db: DB, importId: string): Promise<ImportResult> {
  const imp = await getContactImport(db, importId);
  if (!imp) throw new ContactImportError(`import ${importId} not found`);
  if (imp.status !== 'preview') throw new ContactImportError(`import is already ${imp.status}`);
  const rows = imp.rows as ImportRow[];
  const format = imp.format as keyof typeof IMPORT_SOURCE;
  const source = IMPORT_SOURCE[format] ?? 'manual_import';
  const matches = await matchCompanies(db, rows);
  const companyIds = new Map<string, string>();
  const res: ImportResult = { contactsCreated: 0, contactsUpdated: 0, companiesCreated: 0, skipped: [] };

  for (const m of matches) {
    if (m.companyId) companyIds.set(normalizeCompanyName(m.name), m.companyId);
    else {
      const c = await upsertCompany(db, { name: m.name, notes: `added by contact import (${imp.filename})` });
      companyIds.set(normalizeCompanyName(m.name), c.id);
      if (c.created) res.companiesCreated++;
    }
  }

  for (const r of rows) {
    if (r.action !== 'import') {
      res.skipped.push({ line: r.line, reason: r.problems.join('; ') || 'skipped' });
      continue;
    }
    const companyId = companyIds.get(normalizeCompanyName(r.company!))!;
    const notes = [r.notes, r.location ? `location: ${r.location}` : null].filter(Boolean).join(' · ') || null;
    try {
      const { contact, created } = await upsertContact(db, {
        companyId,
        name: r.name,
        role: r.title,
        email: r.email,
        linkedinUrl: r.linkedinUrl,
        notes,
        source,
      });
      await setContactImportFields(db, contact.id, {
        importId,
        source,
        ...(format === 'linkedin_connections' ? { linkedinDegree: 1 } : {}),
        ...(r.connectedOn ? { connectedOn: r.connectedOn } : {}),
        ...(r.phone ? { phone: r.phone } : {}),
      });
      if (created) res.contactsCreated++;
      else res.contactsUpdated++;
    } catch (err) {
      const reason = err instanceof AmbiguousContactError ? `${(err as Error).message} — add a LinkedIn URL or email to tell them apart` : (err as Error).message;
      res.skipped.push({ line: r.line, reason });
    }
  }
  const done = await finishContactImport(db, importId, 'committed', res);
  if (!done) throw new ContactImportError('import changed state while committing');
  await appendEvent(db, { kind: 'contacts.imported', subjectType: 'contact_import', subjectId: importId, payload: { ...res, skipped: res.skipped.length, format } });
  return res;
}

export async function discardContactImport(db: DB, importId: string): Promise<boolean> {
  return !!(await finishContactImport(db, importId, 'discarded'));
}

export type { ContactImportRow };
