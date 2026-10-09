import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addBenchmarkJob,
  deleteBenchmarkCategory,
  getJobResume,
  getResumeVariant,
  listBenchmarkJobs,
  listBenchmarkScores,
  listLibraryResumes,
  listResumeVariantsForJob,
  removeBenchmarkJob,
  upsertBenchmarkCategory,
  type DB,
  type ResumeVariantRow,
} from '@jobforge/db';
import {
  autoPickBenchmarks,
  ensureCategories,
  generateLibrary,
  runBenchmarks,
  selectResumeForJob,
  type BenchmarkCell,
  type LibraryRunItem,
  type TailorRunDeps,
} from '@jobforge/core';

// Phase 16: the resume library (Resumes page), benchmarks, and the per-job selector.

export interface LibraryRouteOptions {
  db: DB;
  tailorDeps?: () => Promise<TailorRunDeps>;
}

/** Variant rows without the bulky scoring columns (text, embedding). */
export function publicVariant(v: ResumeVariantRow): Omit<ResumeVariantRow, 'resumeText' | 'embedding'> {
  const { resumeText: _t, embedding: _e, ...rest } = v;
  return rest;
}

export interface LibraryRunState {
  running: boolean;
  retire: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  items: LibraryRunItem[];
  retired: number;
  benchmarks: { resumes: number; jobs: number; scored: number } | null;
  error: string | null;
}

const idParams = z.object({ id: z.string().uuid() });

export function registerLibraryRoutes(app: FastifyInstance, o: LibraryRouteOptions): void {
  const { db } = o;
  const deps = async () => {
    if (!o.tailorDeps) throw Object.assign(new Error('tailoring is not configured on this server'), { statusCode: 503 });
    return o.tailorDeps();
  };

  // One generation run at a time; the page polls GET /api/resumes/library/run.
  let run: LibraryRunState = {
    running: false,
    retire: false,
    startedAt: null,
    finishedAt: null,
    done: 0,
    total: 0,
    items: [],
    retired: 0,
    benchmarks: null,
    error: null,
  };

  // --- per job -------------------------------------------------------------
  app.post('/api/jobs/:id/tailor', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const b = z.object({ force: z.boolean().default(false) }).strict().parse(req.body ?? {});
    const r = await selectResumeForJob(await deps(), id, { force: b.force });
    return reply.status(r.cached ? 200 : 201).send({ variant: publicVariant(r.variant), decision: r.decision, cached: r.cached });
  });

  app.get('/api/jobs/:id/resume-variants', async (req) => {
    const { id } = idParams.parse(req.params);
    const variants = await listResumeVariantsForJob(db, id);
    const selection = await getJobResume(db, id);
    // The chosen resume may be a library combo (no job id), so fetch it separately.
    const chosen = selection ? await getResumeVariant(db, selection.variantId) : null;
    const combo = selection?.comboVariantId ? await getResumeVariant(db, selection.comboVariantId) : null;
    return {
      variants: variants.map(publicVariant),
      selection: selection
        ? { ...selection, chosen: chosen ? publicVariant(chosen) : null, combo: combo ? publicVariant(combo) : null }
        : null,
    };
  });

  // --- library ---------------------------------------------------------------
  app.get('/api/resumes/library', async (req) => {
    const q = z.object({ includeRetired: z.coerce.boolean().default(false) }).parse(req.query);
    const resumes = await listLibraryResumes(db, { includeRetired: q.includeRetired });
    const categories = await ensureCategories(await depsOrDb());
    const benchmarkJobs = await listBenchmarkJobs(db);
    const scores = await listBenchmarkScores(db, resumes.map((r) => r.id));
    return {
      resumes: resumes.map(publicVariant),
      categories,
      benchmarkJobs: benchmarkJobs.map(({ descriptionMd: _d, ...j }) => j),
      matrix: benchmarkMatrix(scores, benchmarkJobs),
      scores: scores.map((s) => ({ variantId: s.variantId, jobId: s.jobId, scores: s.scores })),
      run,
    };
  });

  /** Categories only need the DB + resumes config; fall back to defaults when tailoring isn't configured. */
  async function depsOrDb(): Promise<TailorRunDeps> {
    if (o.tailorDeps) return o.tailorDeps();
    return { db } as TailorRunDeps;
  }

  app.get('/api/resumes/library/run', async () => run);

  app.post('/api/resumes/library/generate', async (req, reply) => {
    const b = z.object({ retire: z.boolean().default(false) }).strict().parse(req.body ?? {});
    if (run.running) return reply.status(409).send({ error: 'busy', message: 'a library run is already in progress', run });
    const d = await deps();
    run = {
      running: true,
      retire: b.retire,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      done: 0,
      total: 0,
      items: [],
      retired: 0,
      benchmarks: null,
      error: null,
    };
    const current = run;
    void (async () => {
      try {
        const r = await generateLibrary(d, {
          retire: b.retire,
          onItem: (item, done, total) => {
            current.items.push(item);
            current.done = done;
            current.total = total;
          },
        });
        current.retired = r.retired;
        // Benchmark the new library straight away (auto-pick JDs the first time).
        if (!(await listBenchmarkJobs(db)).length) await autoPickBenchmarks(d);
        current.benchmarks = await runBenchmarks(d);
      } catch (err) {
        current.error = (err as Error).message;
        d.log.error({ err: current.error }, 'resume library run failed');
      } finally {
        current.running = false;
        current.finishedAt = new Date().toISOString();
      }
    })();
    return reply.status(202).send(run);
  });

  // --- benchmarks ----------------------------------------------------------
  app.post('/api/resumes/benchmarks/pick', async (req) => {
    const b = z.object({ categoryId: z.string().optional() }).strict().parse(req.body ?? {});
    const d = await deps();
    const picked = await autoPickBenchmarks(d, b.categoryId ? { categoryId: b.categoryId } : {});
    return { picked, benchmarks: await runBenchmarks(d) };
  });

  app.post('/api/resumes/benchmarks/run', async () => ({ benchmarks: await runBenchmarks(await deps()) }));

  const categoryBody = z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      label: z.string().min(1).max(80),
      titleKeywords: z.array(z.string().trim().min(1)).min(1),
      excludeKeywords: z.array(z.string().trim().min(1)).default([]),
    })
    .strict();

  app.post('/api/resumes/categories', async (req, reply) => {
    const c = categoryBody.parse(req.body);
    return reply.status(201).send(await upsertBenchmarkCategory(db, c));
  });

  app.delete('/api/resumes/categories/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await deleteBenchmarkCategory(db, id);
    return { ok: true };
  });

  app.post('/api/resumes/benchmarks/jobs', async (req, reply) => {
    const b = z.object({ categoryId: z.string(), jobId: z.string().uuid() }).strict().parse(req.body);
    await addBenchmarkJob(db, { ...b, pinned: true });
    return reply.status(201).send({ ok: true });
  });

  app.delete('/api/resumes/benchmarks/jobs/:categoryId/:jobId', async (req) => {
    const p = z.object({ categoryId: z.string(), jobId: z.string().uuid() }).parse(req.params);
    await removeBenchmarkJob(db, p.categoryId, p.jobId);
    return { ok: true };
  });
}

/** variantId → categoryId → { avg, byAts } (means over the category's JDs). */
export function benchmarkMatrix(
  scores: Array<{ variantId: string; jobId: string; scores: unknown }>,
  jobs: Array<{ categoryId: string; jobId: string }>,
): Record<string, Record<string, { avg: number; byAts: Record<string, number>; jobs: number }>> {
  const out: Record<string, Record<string, { avg: number; byAts: Record<string, number>; jobs: number }>> = {};
  for (const cat of new Set(jobs.map((j) => j.categoryId))) {
    const catJobs = new Set(jobs.filter((j) => j.categoryId === cat).map((j) => j.jobId));
    const byVariant = new Map<string, Array<Record<string, BenchmarkCell>>>();
    for (const s of scores) {
      if (!catJobs.has(s.jobId)) continue;
      const list = byVariant.get(s.variantId) ?? [];
      list.push(s.scores as Record<string, BenchmarkCell>);
      byVariant.set(s.variantId, list);
    }
    for (const [variantId, rows] of byVariant) {
      const byAts: Record<string, number> = {};
      for (const ats of Object.keys(rows[0] ?? {})) {
        byAts[ats] = Math.round(rows.reduce((n, r) => n + (r[ats]?.score ?? 0), 0) / rows.length);
      }
      const vals = Object.values(byAts);
      (out[variantId] ??= {})[cat] = { avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0, byAts, jobs: rows.length };
    }
  }
  return out;
}
