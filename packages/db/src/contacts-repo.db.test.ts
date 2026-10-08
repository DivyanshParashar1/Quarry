import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, testDbAdminUrl, type TestDb } from './testing.js';
import { AmbiguousContactError, listContacts, normalizeLinkedinUrl, upsertContact } from './contacts-repo.js';
import { upsertCompany } from './repos.js';

const adminUrl = testDbAdminUrl();

describe('normalizeLinkedinUrl', () => {
  it('canonicalises profile URLs and leaves other values alone', () => {
    expect(normalizeLinkedinUrl('linkedin.com/in/Rahul-Sharma-12?trk=x')).toBe('https://www.linkedin.com/in/rahul-sharma-12/');
    expect(normalizeLinkedinUrl(' https://in.linkedin.com/in/rahul%2Dsharma/ ')).toBe('https://www.linkedin.com/in/rahul-sharma/');
    expect(normalizeLinkedinUrl('https://example.com/rahul')).toBe('https://example.com/rahul');
    expect(normalizeLinkedinUrl('  ')).toBeNull();
    expect(normalizeLinkedinUrl(undefined)).toBeNull();
  });
});

describe.skipIf(!adminUrl)('upsertContact identity (postgres)', () => {
  let t: TestDb;
  let companyId: string;

  beforeAll(async () => {
    t = await createTestDb(adminUrl!);
    companyId = (await upsertCompany(t.db, { name: 'Acme', domain: 'acme.com' })).id;
  });
  afterAll(async () => t?.drop());

  it('keeps two same-name people with different LinkedIn profiles apart', async () => {
    const a = await upsertContact(t.db, { companyId, name: 'Rahul Sharma', linkedinUrl: 'https://www.linkedin.com/in/rahul-a/', source: 'linkedin' });
    const b = await upsertContact(t.db, { companyId, name: 'rahul sharma', linkedinUrl: 'linkedin.com/in/RAHUL-B?x=1', source: 'linkedin' });
    expect(a.created && b.created).toBe(true);
    expect(a.contact.id).not.toBe(b.contact.id);
    expect(b.contact.linkedinUrl).toBe('https://www.linkedin.com/in/rahul-b/');

    const again = await upsertContact(t.db, { companyId, name: 'Rahul S.', role: 'SDE II', linkedinUrl: 'https://in.linkedin.com/in/rahul-a' });
    expect(again).toMatchObject({ created: false, contact: { id: a.contact.id, role: 'SDE II' } });
  });

  it('refuses a bare name that matches several profiles', async () => {
    await expect(upsertContact(t.db, { companyId, name: 'Rahul Sharma', email: 'r@acme.com' })).rejects.toBeInstanceOf(AmbiguousContactError);
  });

  it('merges by name without a profile and adopts that contact once a profile arrives', async () => {
    const manual = await upsertContact(t.db, { companyId, name: 'Priya Iyer', email: 'priya@acme.com' });
    const same = await upsertContact(t.db, { companyId, name: 'PRIYA IYER', role: 'EM' });
    expect(same).toMatchObject({ created: false, contact: { id: manual.contact.id, role: 'EM' } });

    const withProfile = await upsertContact(t.db, { companyId, name: 'Priya Iyer', linkedinUrl: 'https://www.linkedin.com/in/priya-iyer/' });
    expect(withProfile).toMatchObject({ created: false, contact: { id: manual.contact.id, email: 'priya@acme.com' } });
    // The single Priya now has a profile; a bare-name update still finds her.
    const bare = await upsertContact(t.db, { companyId, name: 'Priya Iyer', notes: 'met at meetup' });
    expect(bare.contact.id).toBe(manual.contact.id);

    expect((await listContacts(t.db, { companyId })).map((c) => c.name).sort()).toEqual(['Priya Iyer', 'Rahul Sharma', 'rahul sharma']);
  });
});
