import { and, desc, eq } from 'drizzle-orm';
import type { DB } from './client.js';
import { resumeVariants } from './schema.js';

export type ResumeVariantRow = typeof resumeVariants.$inferSelect;
export type ResumeStatus = ResumeVariantRow['status'];

export interface NewResumeVariant {
  jobId: string;
  profileVersion: string;
  pluginId: string;
  templateId: string;
  factIds: string[];
  bullets: unknown;
  header: unknown;
  validationReport: unknown;
  status: ResumeStatus;
  pdfPath: string | null;
  pdfBytes: number | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  confidence: number | null;
}

export async function insertResumeVariant(db: DB, v: NewResumeVariant): Promise<ResumeVariantRow> {
  const [row] = await db.insert(resumeVariants).values(v).returning();
  return row!;
}

export async function getResumeVariant(db: DB, id: string): Promise<ResumeVariantRow | null> {
  const [r] = await db.select().from(resumeVariants).where(eq(resumeVariants.id, id));
  return r ?? null;
}

export async function listResumeVariantsForJob(db: DB, jobId: string): Promise<ResumeVariantRow[]> {
  return db
    .select()
    .from(resumeVariants)
    .where(eq(resumeVariants.jobId, jobId))
    .orderBy(desc(resumeVariants.createdAt));
}

/** The most recent successfully-rendered variant for a job (used to auto-attach to outreach). */
export async function latestRenderedResumeForJob(db: DB, jobId: string): Promise<ResumeVariantRow | null> {
  const [r] = await db
    .select()
    .from(resumeVariants)
    .where(and(eq(resumeVariants.jobId, jobId), eq(resumeVariants.status, 'rendered')))
    .orderBy(desc(resumeVariants.createdAt))
    .limit(1);
  return r ?? null;
}
