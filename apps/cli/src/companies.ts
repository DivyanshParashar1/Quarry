import { z } from 'zod';
import { ATS_TYPES, upsertCompany, upsertCompanySource, type DB } from '@jobforge/db';
import { formatWorkdayToken, parseWorkdayToken } from '@jobforge/source-workday';
import { parseCsvRecords } from './csv.js';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const companyRowSchema = z
  .object({
    name: z.string().min(1, 'name is required'),
    ats_type: z.preprocess(blankToUndefined, z.enum(ATS_TYPES).optional()),
    board_token: z.preprocess(blankToUndefined, z.string().optional()),
    domain: z.preprocess(blankToUndefined, z.string().optional()),
    location: z.preprocess(blankToUndefined, z.string().optional()),
    notes: z.preprocess(blankToUndefined, z.string().optional()),
    tags: z.preprocess(
      (v) => (typeof v === 'string' ? v.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : []),
      z.array(z.string()),
    ),
    // Phase 6 convenience columns; folded into ats_type/board_token below.
    /** `walmart.wd5` (tenant + data centre), or a full myworkdayjobs URL. */
    workday_tenant: z.preprocess(blankToUndefined, z.string().optional()),
    workday_site: z.preprocess(blankToUndefined, z.string().optional()),
    smartrecruiters_company_id: z.preprocess(blankToUndefined, z.string().optional()),
  })
  .transform((r, ctx) => {
    const out = { ...r };
    if (r.workday_tenant && (!r.ats_type || r.ats_type === 'workday') && !r.board_token) {
      out.ats_type = 'workday';
      const raw = /^https?:/i.test(r.workday_tenant) ? r.workday_tenant : `${r.workday_tenant}/${r.workday_site ?? ''}`;
      try {
        out.board_token = formatWorkdayToken(parseWorkdayToken(raw));
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['workday_tenant'], message: (err as Error).message });
        return z.NEVER;
      }
    } else if (out.ats_type === 'workday' && out.board_token) {
      try {
        out.board_token = formatWorkdayToken(parseWorkdayToken(out.board_token));
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['board_token'], message: (err as Error).message });
        return z.NEVER;
      }
    }
    if (r.smartrecruiters_company_id && (!r.ats_type || r.ats_type === 'smartrecruiters') && !r.board_token) {
      out.ats_type = 'smartrecruiters';
      out.board_token = r.smartrecruiters_company_id;
    }
    return out;
  })
  .refine((r) => !r.ats_type || ['careers_page', 'other'].includes(r.ats_type) || !!r.board_token, {
    message: 'board_token is required for every ATS except careers_page and other',
    path: ['board_token'],
  });
export type CompanyRow = z.infer<typeof companyRowSchema>;

export interface ParsedCompanies {
  rows: CompanyRow[];
  errors: string[];
}

export function parseCompaniesCsv(text: string): ParsedCompanies {
  const rows: CompanyRow[] = [];
  const errors: string[] = [];
  for (const { line, record } of parseCsvRecords(text)) {
    const r = companyRowSchema.safeParse(record);
    if (r.success) rows.push(r.data);
    else errors.push(`line ${line}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { rows, errors };
}

export interface ImportResult {
  companiesCreated: number;
  companiesUpdated: number;
  sourcesCreated: number;
  sourcesExisting: number;
}

/** Idempotent: re-importing the same file creates nothing new. */
export async function importCompanies(db: DB, rows: CompanyRow[]): Promise<ImportResult> {
  const res: ImportResult = { companiesCreated: 0, companiesUpdated: 0, sourcesCreated: 0, sourcesExisting: 0 };
  for (const r of rows) {
    const c = await upsertCompany(db, {
      name: r.name,
      domain: r.domain,
      location: r.location,
      notes: r.notes,
      tags: r.tags,
      discoveredVia: 'csv',
    });
    if (c.created) res.companiesCreated++;
    else res.companiesUpdated++;
    if (r.ats_type && r.board_token) {
      const s = await upsertCompanySource(db, { companyId: c.id, atsType: r.ats_type, boardToken: r.board_token, detectedBy: 'csv' });
      if (s.created) res.sourcesCreated++;
      else res.sourcesExisting++;
    }
  }
  return res;
}
