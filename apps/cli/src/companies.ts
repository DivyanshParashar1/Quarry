import { z } from 'zod';
import { ATS_TYPES, upsertCompany, upsertCompanySource, type DB } from '@jobforge/db';
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
  })
  .refine((r) => !r.ats_type || ['careers_page', 'other'].includes(r.ats_type) || !!r.board_token, {
    message: 'board_token is required for greenhouse, lever and ashby',
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
    });
    if (c.created) res.companiesCreated++;
    else res.companiesUpdated++;
    if (r.ats_type && r.board_token) {
      const s = await upsertCompanySource(db, { companyId: c.id, atsType: r.ats_type, boardToken: r.board_token });
      if (s.created) res.sourcesCreated++;
      else res.sourcesExisting++;
    }
  }
  return res;
}
