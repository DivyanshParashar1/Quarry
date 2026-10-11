import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listContacts, upsertCompany, upsertContact } from '@quarry/db';
import { createTestDb, testDbAdminUrl, type TestDb } from '@quarry/db/testing';
import { commitContactImport, ContactImportError, discardContactImport, getImportPreview, previewContactImport } from './index.js';

const adminUrl = testDbAdminUrl();
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'contacts');

describe.skipIf(!adminUrl)('contact import (postgres)', () => {
  let t: TestDb;
  let acme: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    acme = (await upsertCompany(t.db, { name: 'Acme Payments', domain: 'acmepay.com' })).id;
    await upsertCompany(t.db, { name: 'Initech' });
    // Already known from an earlier fan-out: the import should update, not duplicate, him.
    await upsertContact(t.db, { companyId: acme, name: 'Aarav Mehta', linkedinUrl: 'https://www.linkedin.com/in/aarav-mehta-12ab34/', source: 'linkedin' });
  });
  afterAll(async () => t?.drop());

  it('previews the LinkedIn export with company matches, then commits connections as 1st-degree', async () => {
    const p = await previewContactImport(t.db, { data: await readFile(join(FIX, 'Connections.csv')), filename: 'Connections.csv' });
    expect(p.report.format).toBe('linkedin_connections');
    expect(p.companies).toEqual([
      expect.objectContaining({ name: 'Acme Payments', companyId: acme, via: 'name', rows: 1 }),
      expect.objectContaining({ name: 'Globex', companyId: null, via: null }),
      expect.objectContaining({ name: 'Initech Pvt. Ltd.', matchedName: 'Initech', via: 'name' }),
    ]);
    expect(p.problems.map((r) => r.line)).toEqual([8, 9]);
    expect((await getImportPreview(t.db, p.importId))!.report.rows).toEqual(p.report.rows);

    const r = await commitContactImport(t.db, p.importId);
    expect(r).toMatchObject({ contactsCreated: 2, contactsUpdated: 1, companiesCreated: 1 });
    expect(r.skipped.map((s) => s.line)).toEqual([8, 9]);

    const acmePeople = await listContacts(t.db, { companyId: acme });
    expect(acmePeople).toHaveLength(1);
    expect(acmePeople[0]).toMatchObject({
      name: 'Aarav Mehta',
      source: 'linkedin_export',
      linkedinDegree: 1,
      connectedOn: '2024-03-05',
      role: 'Software Engineer II',
      importId: p.importId,
    });
    const isha = (await listContacts(t.db, { company: 'Globex' }))[0]!;
    expect(isha).toMatchObject({ email: 'isha.verma@example.com', emailConfidence: 1, linkedinDegree: 1 });

    await expect(commitContactImport(t.db, p.importId)).rejects.toThrow(ContactImportError);
  });

  it('matches a company by work-email domain and imports a hand-made CSV as manual_import', async () => {
    const csv = 'Name,Email,Company\nKaran Rao,karan@acmepay.com,ACME Pay (India)\nTara Singh,,Brand New Co\n';
    const p = await previewContactImport(t.db, { data: Buffer.from(csv), filename: 'mine.csv' });
    expect(p.companies.find((c) => c.name === 'ACME Pay (India)')).toMatchObject({ companyId: acme, via: 'email_domain' });
    const r = await commitContactImport(t.db, p.importId);
    expect(r).toMatchObject({ contactsCreated: 2, companiesCreated: 1 });
    const karan = (await listContacts(t.db, { companyId: acme })).find((c) => c.name === 'Karan Rao')!;
    expect(karan).toMatchObject({ source: 'manual_import', linkedinDegree: null, email: 'karan@acmepay.com' });
  });

  it('discards a preview without writing anything', async () => {
    const p = await previewContactImport(t.db, { data: Buffer.from('Name,Company\nZed,Nowhere Inc\n'), filename: 'x.csv' });
    expect(await discardContactImport(t.db, p.importId)).toBe(true);
    await expect(commitContactImport(t.db, p.importId)).rejects.toThrow(/already discarded/);
    expect(await listContacts(t.db, { company: 'Nowhere' })).toEqual([]);
  });
});
