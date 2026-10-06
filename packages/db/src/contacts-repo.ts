import { and, asc, eq, ilike, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { DB } from './client.js';
import { companies, contacts } from './schema.js';

export type ContactRow = typeof contacts.$inferSelect;
export type CompanyRow = typeof companies.$inferSelect;

export interface ContactInput {
  companyId: string;
  name: string;
  role?: string | null | undefined;
  email?: string | null | undefined;
  linkedinUrl?: string | null | undefined;
  notes?: string | null | undefined;
  source?: string | undefined;
}

/**
 * Insert or update a contact by (company, case-insensitive name). A supplied
 * email is treated as known (confidence 1, source manual) and replaces any
 * inferred one; empty fields never overwrite existing values.
 */
export async function upsertContact(db: DB, c: ContactInput): Promise<{ contact: ContactRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, c.companyId), sql`lower(${contacts.name}) = lower(${c.name.trim()})`));
    const emailFields = c.email
      ? { email: c.email.trim().toLowerCase(), emailConfidence: 1, emailSource: 'manual', status: 'active' as const }
      : {};
    if (!existing) {
      const [row] = await tx
        .insert(contacts)
        .values({
          companyId: c.companyId,
          name: c.name.trim(),
          role: c.role ?? null,
          linkedinUrl: c.linkedinUrl ?? null,
          notes: c.notes ?? null,
          source: c.source ?? 'manual',
          ...emailFields,
        })
        .returning();
      return { contact: row!, created: true };
    }
    const [row] = await tx
      .update(contacts)
      .set({
        ...(c.role ? { role: c.role } : {}),
        ...(c.linkedinUrl ? { linkedinUrl: c.linkedinUrl } : {}),
        ...(c.notes ? { notes: c.notes } : {}),
        ...emailFields,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, existing.id))
      .returning();
    return { contact: row!, created: false };
  });
}

export interface ContactListRow extends ContactRow {
  companyName: string;
}

export async function listContacts(
  db: DB,
  f: { companyId?: string; company?: string; withEmail?: boolean } = {},
): Promise<ContactListRow[]> {
  const conds: SQL[] = [];
  if (f.companyId) conds.push(eq(contacts.companyId, f.companyId));
  if (f.company) conds.push(ilike(companies.name, `%${f.company}%`));
  if (f.withEmail) conds.push(isNotNull(contacts.email));
  const rows = await db
    .select({ c: contacts, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(companies.name), asc(contacts.name));
  return rows.map((r) => ({ ...r.c, companyName: r.companyName }));
}

export async function getContact(db: DB, id: string): Promise<ContactListRow | null> {
  const [r] = await db
    .select({ c: contacts, companyName: companies.name })
    .from(contacts)
    .innerJoin(companies, eq(companies.id, contacts.companyId))
    .where(eq(contacts.id, id));
  return r ? { ...r.c, companyName: r.companyName } : null;
}

export async function getCompany(db: DB, id: string): Promise<CompanyRow | null> {
  const [r] = await db.select().from(companies).where(eq(companies.id, id));
  return r ?? null;
}

export async function findCompanyByName(db: DB, name: string): Promise<CompanyRow | null> {
  const [r] = await db.select().from(companies).where(sql`lower(${companies.name}) = lower(${name.trim()})`);
  return r ?? null;
}

export async function setCompanyEmailInfo(
  db: DB,
  companyId: string,
  info: { emailDomain: string | null; mxHosts: string[] | null; pattern: string | null; patternConfidence: number | null },
): Promise<void> {
  await db
    .update(companies)
    .set({
      emailDomain: info.emailDomain,
      mxHosts: info.mxHosts,
      mxCheckedAt: new Date(),
      emailPattern: info.pattern,
      emailPatternConfidence: info.patternConfidence,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));
}

/** Set an inferred/provided email, but never overwrite a manual one or resurrect a bounced address. */
export async function setInferredEmail(
  db: DB,
  contactId: string,
  e: { email: string | null; confidence: number; source: string },
): Promise<boolean> {
  const updated = await db
    .update(contacts)
    .set({ email: e.email, emailConfidence: e.confidence, emailSource: e.source, updatedAt: new Date() })
    .where(
      and(
        eq(contacts.id, contactId),
        sql`(${contacts.emailSource} is null or ${contacts.emailSource} <> 'manual')`,
        sql`${contacts.status} <> 'bounced'`,
      ),
    )
    .returning({ id: contacts.id });
  return updated.length > 0;
}

export async function setContactStatus(db: DB, contactId: string, status: ContactRow['status']): Promise<void> {
  await db
    .update(contacts)
    .set({ status, ...(status === 'bounced' ? { emailConfidence: 0 } : {}), updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}
