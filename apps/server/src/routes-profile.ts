import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  factSchema,
  preferencesSchema,
  readProfileDir,
  deleteFactInFile,
  upsertFactInFile,
  writePreferencesFile,
  type LLMClient,
} from '@jobforge/shared';
import { extractPdfText, loadProfile } from '@jobforge/core';
import type { DB } from '@jobforge/db';

// Full profile editor (PLAN.md §8 Phase 5-ish): facts.yaml + preferences.yaml are
// the source of truth; the DB is a derived read model. Every write goes through
// these endpoints -> yaml -> `loadProfile` to re-sync the DB in one atomic step.

export interface ProfileRouteOptions {
  db: DB;
  profileDir?: string;
  /** LLM client, built lazily. Required for /fix and /import endpoints. */
  llm?: () => Promise<LLMClient>;
}

const FactUpdate = factSchema.omit({ id: true }).partial();
const factBody = factSchema;

export function registerProfileRoutes(app: FastifyInstance, o: ProfileRouteOptions): void {
  const { db } = o;
  const dir = () => {
    if (!o.profileDir || !existsSync(join(o.profileDir, 'facts.yaml'))) {
      throw Object.assign(new Error('profile directory not found on this server'), { statusCode: 503 });
    }
    return o.profileDir;
  };
  const llm = async () => {
    if (!o.llm) throw Object.assign(new Error('LLM is not configured on this server'), { statusCode: 503 });
    return o.llm();
  };

  app.get('/api/profile/full', async () => {
    const d = dir();
    return readProfileDir(d);
  });

  app.post('/api/profile/facts', async (req, reply) => {
    const body = factBody.parse(req.body ?? {});
    const d = dir();
    const r = upsertFactInFile(join(d, 'facts.yaml'), body);
    const loaded = await loadProfile(db, d);
    return reply.status(r.created ? 201 : 200).send({ fact: r.fact, created: r.created, profileVersion: loaded.version });
  });

  app.patch('/api/profile/facts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const patch = FactUpdate.parse(req.body ?? {});
    const d = dir();
    const r = upsertFactInFile(join(d, 'facts.yaml'), { id, ...patch });
    const loaded = await loadProfile(db, d);
    return reply.status(r.created ? 201 : 200).send({ fact: r.fact, created: r.created, profileVersion: loaded.version });
  });

  app.delete('/api/profile/facts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(100) }).parse(req.params);
    const d = dir();
    const r = deleteFactInFile(join(d, 'facts.yaml'), id);
    if (!r.deleted) return reply.status(404).send({ error: 'not_found' });
    const loaded = await loadProfile(db, d);
    return { deleted: true, profileVersion: loaded.version };
  });

  app.put('/api/profile/preferences', async (req) => {
    const body = preferencesSchema.parse(req.body ?? {});
    const d = dir();
    const next = writePreferencesFile(join(d, 'preferences.yaml'), body);
    const loaded = await loadProfile(db, d);
    return { preferences: next, profileVersion: loaded.version };
  });

  // One-shot LLM rewrite of a single text field. The caller passes the current
  // text and (optionally) context about what the field is for; we return a
  // tightened rewrite. No DB side effects.
  app.post('/api/profile/fix', async (req) => {
    const body = z
      .object({
        text: z.string().trim().min(1).max(4000),
        /** e.g. "resume bullet", "project description", "profile summary". */
        kind: z.string().trim().min(1).max(80).default('text'),
        instruction: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(req.body ?? {});
    const client = await llm();
    const schema = z.object({ rewrite: z.string().trim().min(1).max(4000) });
    const sys = `You rewrite one piece of a job-seeker's profile to be tighter, more concrete, and more scannable. Preserve every fact in the input: dates, numbers, technologies, employers, project names. Do not invent anything. Return just the rewritten text in the "rewrite" field.`;
    const extra = body.instruction ? `\nAdditional instruction: ${body.instruction}` : '';
    const prompt = `# ${body.kind}\n\n${body.text}${extra}`;
    const r = await client.generate({ task: 'extract', system: sys, prompt, schema, maxTokens: 600 });
    return { rewrite: r.data.rewrite, provider: r.provider, model: r.model };
  });

  // Parse an uploaded resume PDF and ask the LLM to extract fact drafts the
  // user can confirm. We never write to facts.yaml here — the UI stages the
  // drafts and the user POSTs them individually.
  app.post('/api/profile/import', async (req, reply) => {
    const file = await (req as unknown as { file: () => Promise<{ toBuffer: () => Promise<Buffer>; mimetype: string; filename: string } | undefined> }).file();
    if (!file) return reply.status(400).send({ error: 'no_file' });
    if (!/pdf/i.test(file.mimetype) && !/\.pdf$/i.test(file.filename)) {
      return reply.status(400).send({ error: 'bad_type', message: 'only PDFs are accepted' });
    }
    const buf = await file.toBuffer();
    if (buf.length > 10 * 1024 * 1024) return reply.status(413).send({ error: 'too_large', message: 'max 10MB' });
    let parsed: Awaited<ReturnType<typeof extractPdfText>>;
    try {
      parsed = await extractPdfText(buf);
    } catch (err) {
      return reply.status(422).send({ error: 'pdf_parse_failed', message: (err as Error).message });
    }
    const text = parsed.text.trim();
    if (!text) return reply.status(422).send({ error: 'empty_pdf', message: 'the PDF contained no extractable text' });

    const client = await llm();
    const factDraftSchema = z.object({
      drafts: z
        .array(
          z.object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-_.]*$/).describe('stable kebab/snake id, e.g. "exp-acme" or "proj-ledger"'),
            kind: z.enum(['project', 'experience', 'education', 'skill', 'achievement']),
            content: z.string().trim().min(1).max(1000),
            metrics: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
            tags: z.array(z.string()).default([]),
          }),
        )
        .max(40),
    });
    const sys = `You extract a candidate's resume into a structured fact bank. Each row becomes one fact the tailor can later select from. Rules:
- Create one row per: role (experience), project, degree (education), skill group, or notable achievement.
- Never invent anything that isn't in the resume text.
- Put numbers (users, revenue, latency, team size, GPA, years) in "metrics" as well as the content.
- Choose a short stable id per fact; prefer semantic ids like "exp-acme-backend" or "proj-ledger-service".
- content is a single short line, 15-30 words, that reads like a resume bullet.`;
    const prompt = `# Resume text\n${text.slice(0, 20_000)}`;
    const r = await client.generate({ task: 'extract', system: sys, prompt, schema: factDraftSchema, maxTokens: 3000 });
    return { drafts: r.data.drafts, provider: r.provider, model: r.model };
  });
}

