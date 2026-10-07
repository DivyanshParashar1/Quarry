import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deleteBlock, readResume, reorderBlocks, upsertBlock, ResumeFileError } from './resume-files.js';

// Resume content editor API (sub-phase 2 of the block-based tailor):
//   - GET  /api/resume              — manifest + all fragment contents
//   - POST /api/resume/blocks       — create a block
//   - PUT  /api/resume/blocks/:id   — update a block
//   - DELETE /api/resume/blocks/:id — remove a block (its fragment file too)
//   - PUT  /api/resume/order/:section — reorder blocks within a section
// Nothing here runs the tailor; it only mutates files under profile/resume/.

export interface ResumeRouteOptions {
  resumeDir?: string;
}

const blockBody = z.object({
  section: z.string().trim().min(1),
  title: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(32).optional(),
  always_include: z.boolean().optional(),
  tech_stack_line: z.string().trim().max(400).optional(),
  bullets: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        tags: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
      }),
    )
    .max(10)
    .optional(),
  latex: z.string().min(1).max(10_000),
});

const createBlockBody = blockBody.extend({ id: z.string().trim().min(1).max(64) });
const reorderBody = z.object({ ordered_ids: z.array(z.string().min(1)).min(1).max(32) });

export function registerResumeRoutes(app: FastifyInstance, o: ResumeRouteOptions): void {
  const dir = () => {
    if (!o.resumeDir || !existsSync(join(o.resumeDir, 'manifest.yaml'))) {
      throw Object.assign(new Error('resume directory not found on this server'), { statusCode: 503 });
    }
    return o.resumeDir;
  };

  app.get('/api/resume', async () => {
    return readResume(dir());
  });

  app.post('/api/resume/blocks', async (req, reply) => {
    const body = createBlockBody.parse(req.body ?? {});
    try {
      const r = upsertBlock(dir(), body);
      reply.code(r.created ? 201 : 200);
      return r;
    } catch (err) {
      if (err instanceof ResumeFileError) {
        reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>('/api/resume/blocks/:id', async (req, reply) => {
    const body = blockBody.parse(req.body ?? {});
    try {
      const r = upsertBlock(dir(), { ...body, id: req.params.id });
      reply.code(r.created ? 201 : 200);
      return r;
    } catch (err) {
      if (err instanceof ResumeFileError) {
        reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/resume/blocks/:id', async (req, reply) => {
    try {
      const r = deleteBlock(dir(), req.params.id);
      if (!r.deleted) {
        reply.code(404);
        return { error: `block "${req.params.id}" not found` };
      }
      return r;
    } catch (err) {
      if (err instanceof ResumeFileError) {
        reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });

  app.put<{ Params: { section: string } }>('/api/resume/order/:section', async (req, reply) => {
    const body = reorderBody.parse(req.body ?? {});
    try {
      reorderBlocks(dir(), req.params.section, body.ordered_ids);
      return { ok: true };
    } catch (err) {
      if (err instanceof ResumeFileError) {
        reply.code(err.statusCode);
        return { error: err.message };
      }
      throw err;
    }
  });
}
