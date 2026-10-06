import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { factSchema, upsertFactInFile, type AppConfig } from '@jobforge/shared';
import {
  actionsForReviewItem,
  findCompanyByName,
  getCompany,
  getContact,
  getJobDetail,
  getResumeVariant,
  listContacts,
  listResumeVariantsForJob,
  listReviewItems,
  listSourceTargets,
  listThreads,
  pipelineStatus,
  reviewCounts,
  threadCounts,
  matchStats,
  getActiveProfile,
  upsertCompany,
  upsertCompanySource,
  upsertContact,
  ATS_TYPES,
  type DB,
} from '@jobforge/db';
import {
  approveReviewItem,
  draftOutreach,
  editDraft,
  enrichContacts,
  loadProfile,
  rejectReviewItem,
  runAutopilot,
  runTailor,
  type AutopilotRunDeps,
  type OutreachDeps,
  type TailorRunDeps,
} from '@jobforge/core';

export interface OutreachRouteOptions {
  db: DB;
  policy: AppConfig['outreach'];
  /** Built lazily on first use: drafting needs the LLM, enrichment needs DNS. */
  outreachDeps?: () => Promise<OutreachDeps>;
  /** Built lazily on first tailor call (needs the LLM + LaTeX). */
  tailorDeps?: () => Promise<TailorRunDeps>;
  /** Built lazily; shares the LLM / Gmail with outreach. */
  autopilotDeps?: () => Promise<AutopilotRunDeps>;
  /** Enqueue source fetches (the server's pg-boss); absent in tests that don't need it. */
  enqueueFetch?: (companySourceIds: string[]) => Promise<string[]>;
  profileDir?: string;
}

const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(item).optional());

export function registerOutreachRoutes(app: FastifyInstance, o: OutreachRouteOptions): void {
  const { db } = o;
  const deps = async () => {
    if (!o.outreachDeps) throw Object.assign(new Error('outreach is not configured on this server'), { statusCode: 503 });
    return o.outreachDeps();
  };

  // --- pipeline -------------------------------------------------------------
  app.get('/api/pipeline', async () => {
    const profile = await getActiveProfile(db);
    return {
      jobs: await matchStats(db, profile?.version ?? null),
      review: await reviewCounts(db),
      threads: await threadCounts(db),
      ...(await pipelineStatus(db)),
    };
  });

  // --- review queue ----------------------------------------------------------
  app.get('/api/review', async (req) => {
    const q = z
      .object({
        status: csv(z.enum(['pending', 'approved', 'rejected', 'executed', 'failed', 'cancelled'])),
        kind: csv(z.enum(['application', 'outreach', 'followup'])),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .strict()
      .parse(req.query);
    const items = await listReviewItems(db, { status: q.status ?? ['pending', 'approved'], ...(q.kind ? { kind: q.kind } : {}), limit: q.limit });
    return { items };
  });

  app.get('/api/review/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const [item] = await listReviewItems(db, { ids: [id] });
    if (!item) return reply.status(404).send({ error: 'not_found' });
    return { ...item, actions: await actionsForReviewItem(db, id) };
  });

  app.patch('/api/review/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return editDraft(db, id, req.body ?? {});
  });

  app.post('/api/review/:id/approve', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ overrideCompanyCap: z.boolean().default(false), note: z.string().max(500).optional() }).strict().parse(req.body ?? {});
    return approveReviewItem(db, o.policy, id, { overrideCompanyCap: b.overrideCompanyCap, ...(b.note ? { note: b.note } : {}) });
  });

  app.post('/api/review/:id/reject', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ reason: z.string().max(500).optional() }).strict().parse(req.body ?? {});
    return rejectReviewItem(db, id, b.reason ?? null);
  });

  // --- contacts / outreach ---------------------------------------------------
  app.get('/api/contacts', async (req) => {
    const q = z.object({ companyId: uuid.optional(), company: z.string().max(200).optional() }).strict().parse(req.query);
    return { contacts: await listContacts(db, q.companyId ? { companyId: q.companyId } : q.company ? { company: q.company } : {}) };
  });

  app.post('/api/contacts', async (req, reply) => {
    const b = z
      .object({
        companyId: uuid.optional(),
        company: z.string().trim().min(1).max(200).optional(),
        domain: z.string().trim().max(200).optional(),
        name: z.string().trim().min(1).max(200),
        role: z.string().trim().max(200).optional(),
        email: z.string().trim().email().optional(),
        linkedinUrl: z.string().url().optional(),
      })
      .strict()
      .refine((x) => x.companyId || x.company, 'companyId or company is required')
      .parse(req.body ?? {});
    let company = b.companyId ? await getCompany(db, b.companyId) : await findCompanyByName(db, b.company!);
    if (!company && b.company && b.domain) {
      await upsertCompany(db, { name: b.company, domain: b.domain });
      company = await findCompanyByName(db, b.company);
    }
    if (!company) return reply.status(404).send({ error: 'not_found', message: 'unknown company (pass a domain to create it)' });
    if (b.domain && !company.domain) await upsertCompany(db, { name: company.name, domain: b.domain });
    const { contact, created } = await upsertContact(db, { companyId: company.id, name: b.name, role: b.role, email: b.email, linkedinUrl: b.linkedinUrl });
    return reply.status(created ? 201 : 200).send(contact);
  });

  app.post('/api/contacts/enrich', async (req) => {
    const b = z.object({ companyId: uuid.optional() }).strict().parse(req.body ?? {});
    return { results: await enrichContacts(await deps(), b.companyId ? { companyId: b.companyId } : {}) };
  });

  app.post('/api/outreach/draft', async (req, reply) => {
    const b = z.object({ contactId: uuid, jobId: uuid.nullable().optional(), force: z.boolean().optional() }).strict().parse(req.body ?? {});
    const item = await draftOutreach(await deps(), { contactId: b.contactId, jobId: b.jobId ?? null, force: b.force ?? false });
    return reply.status(201).send(item);
  });

  app.get('/api/outreach/threads', async (req) => {
    const q = z.object({ jobId: uuid.optional(), companyId: uuid.optional() }).strict().parse(req.query);
    return { threads: await listThreads(db, q) };
  });

  /** Everything outreach-related for a job's company, for the job detail panel. */
  app.get('/api/jobs/:id/outreach', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const job = await getJobDetail(db, id, null);
    if (!job) return reply.status(404).send({ error: 'not_found' });
    const company = (await getCompany(db, job.company.id))!;
    return {
      company: { id: company.id, name: company.name, domain: company.domain, emailDomain: company.emailDomain, emailPattern: company.emailPattern, emailPatternConfidence: company.emailPatternConfidence },
      contacts: await listContacts(db, { companyId: company.id }),
      reviewItems: await listReviewItems(db, { companyId: company.id, limit: 50 }),
      threads: await listThreads(db, { companyId: company.id }),
    };
  });

  // --- companies / sources (MCP) -------------------------------------------
  app.post('/api/companies', async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1).max(200),
        domain: z.string().trim().max(200).optional(),
        atsType: z.enum(ATS_TYPES).optional(),
        boardToken: z.string().trim().min(1).max(200).optional(),
        tags: z.array(z.string()).optional(),
      })
      .strict()
      .refine((x) => !x.atsType === !x.boardToken, 'atsType and boardToken go together')
      .parse(req.body ?? {});
    const c = await upsertCompany(db, { name: b.name, domain: b.domain ?? null, tags: b.tags });
    const source = b.atsType ? await upsertCompanySource(db, { companyId: c.id, atsType: b.atsType, boardToken: b.boardToken! }) : null;
    return reply.status(c.created ? 201 : 200).send({ companyId: c.id, created: c.created, source });
  });

  app.post('/api/sources/run', async (req, reply) => {
    const b = z
      .object({ atsType: z.enum(ATS_TYPES).optional(), company: z.string().max(200).optional() })
      .strict()
      .parse(req.body ?? {});
    if (!o.enqueueFetch) return reply.status(503).send({ error: 'unavailable', message: 'source workers are not running' });
    const targets = await listSourceTargets(db, { ...(b.atsType ? { atsTypes: [b.atsType] } : {}), ...(b.company ? { companyName: b.company } : {}) });
    const jobIds = await o.enqueueFetch(targets.map((t) => t.companySourceId));
    return reply.status(202).send({ queued: jobIds.length, boards: targets.map((t) => `${t.companyName} (${t.atsType}:${t.boardToken})`) });
  });

  // --- profile facts (MCP) ---------------------------------------------------
  app.put('/api/profile/facts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const patch = factSchema.omit({ id: true }).partial().parse(req.body ?? {});
    const dir = o.profileDir;
    if (!dir || !existsSync(join(dir, 'facts.yaml'))) return reply.status(503).send({ error: 'unavailable', message: 'profile directory not found' });
    const r = upsertFactInFile(join(dir, 'facts.yaml'), { id, ...patch });
    const loaded = await loadProfile(db, dir);
    return reply.status(r.created ? 201 : 200).send({ fact: r.fact, created: r.created, profileVersion: loaded.version });
  });

  app.get('/api/contacts/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const c = await getContact(db, id);
    return c ?? reply.status(404).send({ error: 'not_found' });
  });

  // --- resume variants (tailor) ---------------------------------------------
  const tailor = async () => {
    if (!o.tailorDeps) throw Object.assign(new Error('tailoring is not configured on this server'), { statusCode: 503 });
    return o.tailorDeps();
  };

  app.get('/api/jobs/:id/resume-variants', async (req) => {
    const { id } = idParams.parse(req.params);
    return { variants: await listResumeVariantsForJob(db, id) };
  });

  app.post('/api/jobs/:id/tailor', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const deps = await tailor();
    const r = await runTailor(deps, { jobId: id });
    return reply.status(201).send(r.variant);
  });

  app.get('/api/resume-variants/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const v = await getResumeVariant(db, id);
    return v ?? reply.status(404).send({ error: 'not_found' });
  });

  // --- autopilot -------------------------------------------------------------
  app.post('/api/autopilot/run', async (req, reply) => {
    if (!o.autopilotDeps) return reply.status(503).send({ error: 'unavailable', message: 'autopilot is not configured on this server' });
    const b = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(req.body ?? {});
    const deps = await o.autopilotDeps();
    return runAutopilot(deps, b.limit !== undefined ? { limit: b.limit } : {});
  });

  app.get('/api/resume-variants/:id/pdf', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const v = await getResumeVariant(db, id);
    if (!v) return reply.status(404).send({ error: 'not_found' });
    if (!v.pdfPath || !existsSync(v.pdfPath)) return reply.status(404).send({ error: 'no_pdf', message: v.error ?? 'variant has no rendered PDF' });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="resume-${v.id.slice(0, 8)}.pdf"`)
      .send(createReadStream(v.pdfPath));
  });
}
