import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '@jobforge/shared';
import { getBatchForJob, type DB } from '@jobforge/db';
import {
  approveBatch,
  fanOutReferrals,
  importLinkedInEmployees,
  linkedinHealth,
  linkedinPaused,
  referralPanel,
  resumeLinkedIn,
  syncLinkedInAttention,
  type LinkedInDeps,
  type OutreachDeps,
} from '@jobforge/core';

export interface ReferralRouteOptions {
  db: DB;
  config: AppConfig;
  outreachDeps?: () => Promise<OutreachDeps>;
  /** Absent when LinkedIn isn't configured; `enabled` is false unless LINKEDIN_ENABLED + MODE=live. */
  linkedinDeps?: () => Promise<LinkedInDeps>;
  linkedinEnabled?: boolean;
}

const idParams = z.object({ id: z.string().uuid() });

/** Phase 8 referral fan-out. Drafting has no side effects; approval is the only gate to sending. */
export function registerReferralRoutes(app: FastifyInstance, o: ReferralRouteOptions): void {
  const deps = async () => {
    if (!o.outreachDeps) throw Object.assign(new Error('outreach is not configured on this server'), { statusCode: 503 });
    return o.outreachDeps();
  };

  app.get('/api/jobs/:id/referrals', async (req) => {
    const { id } = idParams.parse(req.params);
    return referralPanel(o.db, id);
  });

  app.post('/api/jobs/:id/referrals/fanout', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ count: z.number().int().min(1).max(50).optional() }).strict().parse(req.body ?? {});
    const li = o.linkedinDeps ? await o.linkedinDeps() : null;
    const r = await fanOutReferrals(
      {
        ...(await deps()),
        linkedinAvailable: !!o.linkedinEnabled,
        ...(li?.enabled
          ? {
              findMoreContacts: async (companyId: string, _jobId: string, wanted: number) =>
                (await importLinkedInEmployees(li, companyId, { maxProfiles: Math.max(wanted * 2, o.config.linkedin.profilesPerCompany) })).contactsCreated,
            }
          : {}),
      },
      id,
      b.count ? { count: b.count } : {},
    );
    return { ...r, panel: await referralPanel(o.db, id) };
  });

  app.post('/api/jobs/:id/referrals/approve', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ ids: z.array(z.string().uuid()).optional() }).strict().parse(req.body ?? {});
    const batch = await getBatchForJob(o.db, id);
    if (!batch) return reply.status(404).send({ error: 'not_found', message: 'no referral batch for this job' });
    const r = await approveBatch(o.db, o.config.outreach, batch.id, b.ids ? { ids: b.ids } : {});
    return { ...r, panel: await referralPanel(o.db, id) };
  });

  app.get('/api/linkedin/status', async () => {
    await syncLinkedInAttention(o.db, o.config.linkedin);
    const h = await linkedinHealth(o.db, o.config.linkedin);
    return { enabled: !!o.linkedinEnabled, paused: await linkedinPaused(o.db, o.config.linkedin), health: h };
  });

  app.post('/api/linkedin/resume', async () => {
    await resumeLinkedIn(o.db, o.config.linkedin, 'resumed from dashboard');
    return { ok: true };
  });
}
