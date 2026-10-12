import { upsertCompany, upsertCompanySource, type DB } from '@quarry/db';
import type { CompanyRow } from '@quarry/plugin-sdk';

// The CSV schema lives in the plugin SDK (shared with the phone fetcher).
export { companyRowSchema, parseCompaniesCsv, type CompanyRow, type ParsedCompanies } from '@quarry/plugin-sdk';

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
