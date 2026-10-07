import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobTimeline, listApplications, PIPELINE_STATES, pipelineStateCounts, type DB, type PipelineState } from '@jobforge/db';
import { advanceJob, expireJob, runSequencer, type SequencerDeps } from '@jobforge/core';

export interface PipelineRouteOptions {
  db: DB;
  sequencerDeps?: () => Promise<SequencerDeps>;
}

const idParams = z.object({ id: z.string().uuid() });

/** Phase 12: the per-job sequencer and the /applications audit page. */
export function registerPipelineRoutes(app: FastifyInstance, o: PipelineRouteOptions): void {
  const deps = async () => {
    if (!o.sequencerDeps) throw Object.assign(new Error('the sequencer is not configured on this server'), { statusCode: 503 });
    return o.sequencerDeps();
  };

  app.get('/api/applications', async (req) => {
    const q = z
      .object({
        state: z
          .string()
          .optional()
          .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
          .pipe(z.array(z.enum(PIPELINE_STATES as unknown as [PipelineState, ...PipelineState[]])).optional()),
        company: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .strict()
      .parse(req.query);
    const r = await listApplications(o.db, { ...(q.state ? { states: q.state } : {}), ...(q.company ? { company: q.company } : {}), limit: q.limit, offset: q.offset });
    return { ...r, counts: await pipelineStateCounts(o.db) };
  });

  app.get('/api/applications/:id/timeline', async (req) => {
    const { id } = idParams.parse(req.params);
    return { timeline: await jobTimeline(o.db, id) };
  });

  app.post('/api/jobs/:id/advance', async (req) => {
    const { id } = idParams.parse(req.params);
    return advanceJob(await deps(), id);
  });

  app.post('/api/jobs/:id/expire', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ reason: z.string().trim().min(1).max(300) }).strict().parse(req.body ?? {});
    return expireJob(o.db, id, b.reason);
  });

  app.post('/api/autopilot/sequence', async (req) => {
    const b = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(req.body ?? {});
    return runSequencer(await deps(), b.limit ? { limit: b.limit } : {});
  });
}
