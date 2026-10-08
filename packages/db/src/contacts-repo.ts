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

/** `linkedin.com/in/<slug>` in any form → `https://www.linkedin.com/in/<slug>/`; anything else is kept as given. */
export function normalizeLinkedinUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = s.match(/linkedin\.com\/in\/([^/?#"'\s]+)/i);
  if (!m) return s;
  let slug = m[1]!;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* keep the raw slug */
  }
  return `https://www.linkedin.com/in/${slug.toLowerCase()}/`;
}

export class AmbiguousContactError extends Error {
  constructor(name: string, count: number) {
    super(`${count} contacts named "${name}" at this company have different LinkedIn profiles; pass the LinkedIn URL to pick one`);
  }
}

/**
 * Insert or update a contact. With a LinkedIn URL the profile is the identity
 * (a same-name contact without a profile is adopted); without one, the
 * case-insensitive name is, as long as it names a single person. A supplied
 * email is treated as known (confidence 1, source manual) and replaces any
 * inferred one; empty fields never overwrite existing values.
 */
export async function upsertContact(db: DB, c: ContactInput): Promise<{ contact: ContactRow; created: boolean }> {
  const linkedinUrl = normalizeLinkedinUrl(c.linkedinUrl);
  return db.transaction(async (tx) => {
    const sameName = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, c.companyId), sql`lower(${contacts.name}) = lower(${c.name.trim()})`));
    let existing: ContactRow | undefined;
    if (linkedinUrl) {
      [existing] = await tx
        .select()
        .from(contacts)
        .where(and(eq(contacts.companyId, c.companyId), eq(contacts.linkedinUrl, linkedinUrl)));
      existing ??= sameName.find((r) => r.linkedinUrl === null);
    } else {
      existing = sameName.length === 1 ? sameName[0] : sameName.find((r) => r.linkedinUrl === null);
      if (!existing && sameName.length > 1) throw new AmbiguousContactError(c.name.trim(), sameName.length);
    }
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
          linkedinUrl,
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
        ...(linkedinUrl ? { linkedinUrl } : {}),
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
        e.email ? sql`not (lower(${e.email}) = any(${contacts.bouncedEmails}))` : undefined,
      ),
    )
    .returning({ id: contacts.id });
  return updated.length > 0;
}

interface EmailCandidate {
  email: string;
  confidence: number;
  pattern?: string;
}

/**
 * A sent email bounced. A pattern-guessed address moves on to the next ranked
 * candidate that hasn't bounced (the person never got the ask, so they stay
 * askable); a known address, or running out of candidates, marks the contact
 * bounced. Returns the address that will be used next, if any.
 */
export async function recordEmailBounce(db: DB, contactId: string, bouncedEmail?: string | null): Promise<{ nextEmail: string | null }> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId)).for('update');
    if (!c) return { nextEmail: null };
    const bounced = (bouncedEmail ?? c.email)?.trim().toLowerCase();
    const bouncedEmails = [...new Set([...c.bouncedEmails, ...(bounced ? [bounced] : [])])];
    // An older address bounced after we had already moved on: just remember it.
    if (bounced && c.email && c.email.toLowerCase() !== bounced) {
      await tx.update(contacts).set({ bouncedEmails, updatedAt: new Date() }).where(eq(contacts.id, contactId));
      return { nextEmail: c.email };
    }
    const guessed = !c.emailSource || c.emailSource.startsWith('pattern:');
    const next = guessed
      ? ((c.emailCandidates as EmailCandidate[]) ?? []).find((x) => x?.email && !bouncedEmails.includes(x.email.toLowerCase()))
      : undefined;
    await tx
      .update(contacts)
      .set(
        next
          ? { bouncedEmails, email: next.email.toLowerCase(), emailConfidence: next.confidence, emailSource: `pattern:${next.pattern ?? 'candidate'}`, status: 'active', updatedAt: new Date() }
          : { bouncedEmails, status: 'bounced', emailConfidence: 0, updatedAt: new Date() },
      )
      .where(eq(contacts.id, contactId));
    return { nextEmail: next?.email.toLowerCase() ?? null };
  });
}

export async function setContactStatus(db: DB, contactId: string, status: ContactRow['status']): Promise<void> {
  await db
    .update(contacts)
    .set({ status, ...(status === 'bounced' ? { emailConfidence: 0 } : {}), updatedAt: new Date() })
    .where(eq(contacts.id, contactId));
}

/** A reply proves the address works. */
export async function confirmContactEmail(db: DB, contactId: string): Promise<void> {
  await db
    .update(contacts)
    .set({
      emailConfidence: 1,
      emailSource: sql`case when ${contacts.emailSource} = 'manual' then 'manual' else 'reply' end`,
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
}
