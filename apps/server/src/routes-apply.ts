import { createReadStream, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionsForReviewItem, getReviewItem, type DB } from '@jobforge/db';
import { draftApplication, type ApplyDeps } from '@jobforge/core';

export interface ApplyRouteOptions {
  db: DB;
  applyDeps?: () => Promise<ApplyDeps>;
  /** Screenshots are only ever served from under this directory. */
  screenshotRoot: string;
}

const idParams = z.object({ id: z.string().uuid() });

/** Phase 11: application drafts and their screenshot audit trail. */
export function registerApplyRoutes(app: FastifyInstance, o: ApplyRouteOptions): void {
  app.post('/api/jobs/:id/apply', async (req) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ preview: z.boolean().default(true) }).strict().parse(req.body ?? {});
    if (!o.applyDeps) throw Object.assign(new Error('applications are not configured on this server'), { statusCode: 503 });
    return draftApplication(await o.applyDeps(), id, { preview: b.preview });
  });

  /** Screenshot n of a review item: preview shots first, then those recorded on its actions. */
  app.get('/api/review/:id/screenshots/:n', async (req, reply) => {
    const { id, n } = z.object({ id: z.string().uuid(), n: z.coerce.number().int().min(0).max(50) }).parse(req.params);
    const item = await getReviewItem(o.db, id);
    if (!item) return reply.status(404).send({ error: 'not_found' });
    const preview = ((item.draft as { previewScreenshots?: string[] }).previewScreenshots ?? []).slice();
    const fromActions = (await actionsForReviewItem(o.db, id)).flatMap((a) => ((a.result as { screenshots?: string[] } | null)?.screenshots ?? []));
    const path = [...preview, ...fromActions][n];
    if (!path) return reply.status(404).send({ error: 'not_found' });
    const root = resolve(o.screenshotRoot);
    const abs = resolve(path);
    if (!abs.startsWith(root + sep) || !abs.endsWith('.png') || !existsSync(abs)) return reply.status(404).send({ error: 'not_found' });
    return reply.type('image/png').send(createReadStream(abs));
  });
}
