import { readFile } from 'node:fs/promises';
import {
  addBenchmarkJob,
  appendEvent,
  atsTypeForJob,
  clearAutoBenchmarkJobs,
  ensureBenchmarkCategories,
  findBenchmarkCandidates,
  getActiveProfile,
  getJobDetail,
  getJobEmbedding,
  getJobResume,
  getResumeVariant,
  listBenchmarkCategories,
  listBenchmarkJobs,
  listBenchmarkScores,
  listLibraryResumes,
  retireLibraryResumes,
  sampleJobDescriptions,
  setJobResume,
  updateResumeScoring,
  upsertBenchmarkScore,
  type BenchmarkCategoryRow,
  type DB,
  type ResumeVariantRow,
} from '@jobforge/db';
import { cosine, jobEmbeddingText } from '@jobforge/embeddings';
import type { Job, Profile, ResumeComboSpec, TailoredResume, TailorPlugin } from '@jobforge/plugin-sdk';
import type { ResumesConfig } from '@jobforge/shared';
import {
  analyzeResumeText,
  atsProfileFor,
  buildDictionary,
  buildIdf,
  extractJdKeywords,
  extractPdfText,
  scoreAllAts,
  scoreResume,
  type AtsProfileType,
  type AtsScore,
  type Dictionary,
  type Idf,
} from './ats-score/index.js';
import { buildContext } from './plugins.js';
import { DEFAULT_TAILOR, jobFromDetail, NoTailorJobError, NoTailorProfileError, persistRendered, runTailor, type TailorRunDeps } from './tailor-runner.js';

// Phase 16 resume library:
//   - generateLibrary: every project combo (+ base resumes) rendered up front,
//     skills tailored to the combo's own projects;
//   - benchmarks: each library resume ATS-scored against a few JDs per job
//     category, under every ATS profile;
//   - selectResumeForJob: deterministic pick of the best library resume for a
//     job (similarity + ATS against the real JD), then a per-job skills rewrite
//     that is kept only if it doesn't lower the ATS score.

export interface LibraryDeps extends TailorRunDeps {
  policy: ResumesConfig;
}

// ---------------------------------------------------------------------------
// Shared scoring context
// ---------------------------------------------------------------------------

export interface AtsContext {
  dictionary: Dictionary;
  idf: Idf | undefined;
}

let idfCache: { at: number; idf: Idf } | null = null;
const IDF_TTL_MS = 60 * 60_000;

/** Lexicon + the user's skills; TF-IDF over a sample of the job corpus (cached for an hour). */
export async function atsContext(db: DB, profile: Profile | null): Promise<AtsContext> {
  const skills = profile ? [...profile.preferences.stack, ...profile.facts.filter((f) => f.kind === 'skill').map((f) => f.content)] : [];
  if (!idfCache || Date.now() - idfCache.at > IDF_TTL_MS) {
    const docs = await sampleJobDescriptions(db);
    idfCache = docs.length >= 20 ? { at: Date.now(), idf: buildIdf(docs) } : null;
  }
  return { dictionary: buildDictionary(skills.filter((s) => s.length <= 40)), idf: idfCache?.idf };
}

/** Test hook: forget the cached corpus statistics. */
export function resetAtsContextCache(): void {
  idfCache = null;
}

/** Make sure a variant has its extracted text (and embedding, when an embedder is available). */
export async function ensureScoring(deps: { db: DB; embed?: TailorRunDeps['embed'] }, v: ResumeVariantRow): Promise<{ text: string | null; embedding: number[] | null }> {
  let text = v.resumeText;
  let embedding = v.embedding;
  const patch: { resumeText?: string; embedding?: number[] } = {};
  if (!text && v.pdfPath) {
    try {
      text = (await extractPdfText(await readFile(v.pdfPath))).text;
      patch.resumeText = text;
    } catch {
      text = null;
    }
  }
  if (!embedding && text && deps.embed) {
    const [vec] = await deps.embed.embed([text.slice(0, 8000)]);
    if (vec) {
      embedding = vec;
      patch.embedding = vec;
    }
  }
  if (Object.keys(patch).length) await updateResumeScoring(deps.db, v.id, patch);
  return { text, embedding: embedding ?? null };
}

export function rescaleSimilarity(cos: number, low: number, high: number): number {
  if (high <= low) return cos >= high ? 100 : 0;
  return Math.round(Math.max(0, Math.min(1, (cos - low) / (high - low))) * 100);
}

// ---------------------------------------------------------------------------
// Library generation
// ---------------------------------------------------------------------------

export interface LibraryRunItem {
  key: string;
  label: string;
  kind: 'combo' | 'base';
  variantId?: string;
  status: 'created' | 'skipped' | 'failed';
  resumeStatus?: string;
  error?: string;
}

export interface LibraryRunResult {
  items: LibraryRunItem[];
  retired: number;
}

function tailorPlugin(deps: TailorRunDeps) {
  const loaded = deps.registry.tailor(DEFAULT_TAILOR);
  const plugin = loaded.plugin as TailorPlugin;
  if (!plugin.listCombos || !plugin.renderFixed) throw new Error(`${DEFAULT_TAILOR} does not support the resume library (listCombos/renderFixed)`);
  return { loaded, plugin: plugin as Required<Pick<TailorPlugin, 'listCombos' | 'renderFixed'>> & TailorPlugin };
}

/**
 * Render every combo/base resume that isn't in the active library yet. With
 * `retire`, render all of them fresh and then retire the previous ones
 * ("Scrap & regenerate"); nothing is retired if no new resume rendered.
 */
export async function generateLibrary(
  deps: LibraryDeps,
  opts: { retire?: boolean; onItem?: (item: LibraryRunItem, done: number, total: number) => void } = {},
): Promise<LibraryRunResult> {
  const profile = await getActiveProfile(deps.db);
  if (!profile) throw new NoTailorProfileError();
  const { loaded, plugin } = tailorPlugin(deps);
  const listCtx = buildContext(loaded, { ...deps, log: deps.log, signal: AbortSignal.timeout(60_000) });
  const specs: ResumeComboSpec[] = await plugin.listCombos(listCtx, { projectsPerResume: deps.policy.projectsPerResume });

  const active = await listLibraryResumes(deps.db);
  const items: LibraryRunItem[] = [];
  for (const [i, spec] of specs.entries()) {
    const existing = active.find((v) => v.comboKey === spec.key && v.kind === spec.kind && v.profileVersion === profile.version);
    let item: LibraryRunItem;
    if (existing && !opts.retire) {
      item = { key: spec.key, label: spec.label, kind: spec.kind, variantId: existing.id, status: 'skipped', resumeStatus: existing.status };
    } else {
      item = await renderLibraryResume(deps, profile, spec);
    }
    items.push(item);
    opts.onItem?.(item, i + 1, specs.length);
  }

  let retired = 0;
  const created = items.filter((i) => i.status === 'created' && i.resumeStatus === 'rendered');
  if (opts.retire && created.length) {
    retired = await retireLibraryResumes(
      deps.db,
      items.filter((i) => i.variantId && i.status !== 'failed').map((i) => i.variantId!),
    );
  }
  await appendEvent(deps.db, {
    kind: 'resume.library.generated',
    subjectType: 'profile',
    subjectId: profile.version,
    payload: {
      created: items.filter((i) => i.status === 'created').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      failed: items.filter((i) => i.status === 'failed').length,
      retired,
    },
  });
  return { items, retired };
}

async function renderLibraryResume(deps: LibraryDeps, profile: Profile, spec: ResumeComboSpec): Promise<LibraryRunItem> {
  const base = { key: spec.key, label: spec.label, kind: spec.kind } as const;
  const { loaded, plugin } = tailorPlugin(deps);
  const log = deps.log.child({ plugin: loaded.manifest.id, combo: spec.key });
  const ctx = buildContext(loaded, { ...deps, log, signal: AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000) });
  try {
    const raw = (await plugin.renderFixed(ctx, {
      includedBlockIds: spec.includedBlockIds,
      skills: { mode: spec.skills },
    })) as TailoredResume;
    const variant = await persistRendered(deps, raw, {
      jobId: null,
      profileVersion: profile.version,
      pluginId: loaded.manifest.id,
      dirName: `library-${spec.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: spec.kind,
      comboKey: spec.key,
      label: spec.label,
    });
    if (variant.status === 'rendered') await ensureScoring(deps, variant);
    return { ...base, variantId: variant.id, status: 'created', resumeStatus: variant.status, ...(variant.error ? { error: variant.error } : {}) };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'resume library: render failed');
    return { ...base, status: 'failed', error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

export async function ensureCategories(deps: { db: DB; policy: ResumesConfig }): Promise<BenchmarkCategoryRow[]> {
  await ensureBenchmarkCategories(deps.db, deps.policy.benchmarks.categories);
  return listBenchmarkCategories(deps.db);
}

/** Re-pick each category's auto (unpinned) JDs: open jobs by title keywords, best match first. */
export async function autoPickBenchmarks(deps: LibraryDeps, opts: { categoryId?: string } = {}): Promise<Record<string, string[]>> {
  const profile = await getActiveProfile(deps.db);
  const categories = (await ensureCategories(deps)).filter((c) => !opts.categoryId || c.id === opts.categoryId);
  const out: Record<string, string[]> = {};
  for (const c of categories) {
    await clearAutoBenchmarkJobs(deps.db, c.id);
    const pinned = await listBenchmarkJobs(deps.db, c.id);
    const picks = await findBenchmarkCandidates(deps.db, {
      titleKeywords: c.titleKeywords,
      excludeKeywords: c.excludeKeywords,
      profileVersion: profile?.version ?? null,
      limit: deps.policy.benchmarks.perCategory - pinned.length,
      excludeJobIds: pinned.map((p) => p.jobId),
    });
    for (const p of picks) await addBenchmarkJob(deps.db, { categoryId: c.id, jobId: p.jobId, pinned: false });
    out[c.id] = [...pinned.map((p) => p.jobId), ...picks.map((p) => p.jobId)];
  }
  return out;
}

export interface BenchmarkCell {
  score: number;
  coverage: number | null;
  hardMissing: string[];
}

/** Score every active rendered library resume against every benchmark JD, under every ATS. */
export async function runBenchmarks(deps: LibraryDeps): Promise<{ resumes: number; jobs: number; scored: number }> {
  const profile = await getActiveProfile(deps.db);
  const ctx = await atsContext(deps.db, profile);
  const library = (await listLibraryResumes(deps.db)).filter((v) => v.status === 'rendered');
  const bench = await listBenchmarkJobs(deps.db);
  const jobs = new Map(bench.map((b) => [b.jobId, b]));
  const jdKeywords = new Map([...jobs.values()].map((j) => [j.jobId, extractJdKeywords(j.descriptionMd ?? '', { dictionary: ctx.dictionary, idf: ctx.idf })]));
  let scored = 0;
  for (const v of library) {
    const { text } = await ensureScoring(deps, v);
    if (!text) continue;
    const parse = analyzeResumeText(text);
    for (const [jobId, jd] of jdKeywords) {
      const all = scoreAllAts({ resumeText: text, parse, jd, dictionary: ctx.dictionary });
      const cells: Record<string, BenchmarkCell> = {};
      for (const [ats, s] of Object.entries(all)) cells[ats] = { score: s.score, coverage: s.keywords.coverage, hardMissing: s.keywords.hardMissing };
      await upsertBenchmarkScore(deps.db, { variantId: v.id, jobId, scores: cells });
      scored++;
    }
  }
  await appendEvent(deps.db, { kind: 'resume.benchmarks.scored', subjectType: 'profile', subjectId: profile?.version ?? 'none', payload: { resumes: library.length, jobs: jobs.size, scored } });
  return { resumes: library.length, jobs: jobs.size, scored };
}

/** The first category whose title keywords match (and excludes don't). */
export function categoryForTitle(title: string, categories: BenchmarkCategoryRow[]): string | null {
  const t = title.toLowerCase();
  for (const c of categories) {
    if (c.excludeKeywords.some((k) => t.includes(k.toLowerCase()))) continue;
    if (c.titleKeywords.some((k) => t.includes(k.toLowerCase()))) return c.id;
  }
  return null;
}

/** Mean benchmark score per variant for one category (mean over its JDs and every ATS profile). */
export async function categoryAverages(db: DB, categoryId: string, variantIds: string[]): Promise<Map<string, number>> {
  const jobsInCat = new Set((await listBenchmarkJobs(db, categoryId)).map((b) => b.jobId));
  const sums = new Map<string, { n: number; total: number }>();
  for (const row of await listBenchmarkScores(db, variantIds)) {
    if (!jobsInCat.has(row.jobId)) continue;
    const cells = Object.values(row.scores as Record<string, BenchmarkCell>);
    const acc = sums.get(row.variantId) ?? { n: 0, total: 0 };
    for (const c of cells) {
      acc.n++;
      acc.total += c.score;
    }
    sums.set(row.variantId, acc);
  }
  return new Map([...sums].map(([id, a]) => [id, a.n ? a.total / a.n : 0]));
}

// ---------------------------------------------------------------------------
// Per-job selection
// ---------------------------------------------------------------------------

export interface SelectorCandidate {
  variantId: string;
  label: string | null;
  similarity: number | null;
  ats: number;
  score: number;
  benchmark: number | null;
}

export interface SelectorDecision {
  atsType: AtsProfileType;
  category: string | null;
  candidates: SelectorCandidate[];
  /** The library resume picked (null when generated from scratch). */
  comboVariantId: string | null;
  comboAts: AtsScore | null;
  tailoredVariantId: string | null;
  tailoredAts: AtsScore | null;
  kept: 'tailored' | 'combo' | 'generated';
  /** Best combined score below `selector.threshold`. */
  weakFit: boolean;
  note: string | null;
}

export interface SelectResult {
  variant: ResumeVariantRow;
  decision: SelectorDecision | null;
  /** True when an earlier decision was returned unchanged. */
  cached: boolean;
}

/**
 * The resume a job should use. Re-uses an earlier decision unless `force`.
 * Library empty → full per-job generation (Phase 15 path).
 */
export async function selectResumeForJob(deps: LibraryDeps, jobId: string, opts: { force?: boolean } = {}): Promise<SelectResult> {
  if (!opts.force) {
    const prior = await getJobResume(deps.db, jobId);
    const v = prior ? await getResumeVariant(deps.db, prior.variantId) : null;
    if (prior && v) return { variant: v, decision: prior.decision as SelectorDecision, cached: true };
  }

  const profile = await getActiveProfile(deps.db);
  if (!profile) throw new NoTailorProfileError();
  const detail = await getJobDetail(deps.db, jobId, profile.version);
  if (!detail) throw new NoTailorJobError(jobId);
  const job = jobFromDetail(detail);
  const atsType = atsProfileFor(await atsTypeForJob(deps.db, jobId));
  const ctx = await atsContext(deps.db, profile);
  const jd = extractJdKeywords(job.descriptionMd ?? '', { dictionary: ctx.dictionary, idf: ctx.idf });
  const scoreText = (text: string) => scoreResume({ resumeText: text, parse: analyzeResumeText(text), jd, dictionary: ctx.dictionary, atsType });

  const library = (await listLibraryResumes(deps.db)).filter((v) => v.status === 'rendered');
  if (!library.length) return generateForJob(deps, job, atsType, scoreText);

  // Score every library resume against this JD.
  const jobVec = await jobVector(deps, job);
  const { similarityWeight, similarityLow, similarityHigh, threshold, tieMargin } = deps.policy.selector;
  const scored: Array<SelectorCandidate & { v: ResumeVariantRow; ats_: AtsScore }> = [];
  for (const v of library) {
    const { text, embedding } = await ensureScoring(deps, v);
    if (!text) continue;
    const ats = scoreText(text);
    const similarity = jobVec && embedding ? rescaleSimilarity(cosine(jobVec, embedding), similarityLow, similarityHigh) : null;
    const score = similarity === null ? ats.score : Math.round(similarityWeight * similarity + (1 - similarityWeight) * ats.score);
    scored.push({ v, ats_: ats, variantId: v.id, label: v.label, similarity, ats: ats.score, score, benchmark: null });
  }
  if (!scored.length) return generateForJob(deps, job, atsType, scoreText);

  // Benchmark averages for the job's category break near-ties.
  const categories = await ensureCategories(deps);
  const category = categoryForTitle(job.title, categories);
  if (category) {
    const avgs = await categoryAverages(deps.db, category, scored.map((s) => s.variantId));
    for (const s of scored) s.benchmark = avgs.has(s.variantId) ? Math.round(avgs.get(s.variantId)!) : null;
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!.score;
  const tied = scored.filter((s) => top - s.score <= tieMargin);
  const best = tied.sort((a, b) => (b.benchmark ?? -1) - (a.benchmark ?? -1) || b.score - a.score)[0]!;

  const decision: SelectorDecision = {
    atsType,
    category,
    candidates: scored.map(({ v: _v, ats_: _a, ...c }) => c),
    comboVariantId: best.variantId,
    comboAts: best.ats_,
    tailoredVariantId: null,
    tailoredAts: null,
    kept: 'combo',
    weakFit: best.score < threshold,
    note: null,
  };

  // Per-job step: only the Technical Skills rewrite on the chosen combo.
  let chosen = best.v;
  const blockIds = (best.v.bullets as { selectedBlockIds?: string[] }).selectedBlockIds ?? [];
  try {
    const { loaded, plugin } = tailorPlugin(deps);
    const log = deps.log.child({ plugin: loaded.manifest.id, jobId });
    const pctx = buildContext(loaded, { ...deps, log, signal: AbortSignal.timeout(deps.timeoutMs ?? 5 * 60_000) });
    const raw = (await plugin.renderFixed(pctx, { includedBlockIds: blockIds, skills: { mode: 'job', job } })) as TailoredResume;
    const tailored = await persistRendered(deps, raw, {
      jobId,
      profileVersion: profile.version,
      pluginId: loaded.manifest.id,
      dirName: `${jobId}-${Date.now()}`,
      kind: 'tailored',
      comboKey: best.v.comboKey,
      label: best.v.label,
      parentVariantId: best.v.id,
    });
    decision.tailoredVariantId = tailored.id;
    if (tailored.status === 'rendered') {
      const { text } = await ensureScoring(deps, tailored);
      const tAts = text ? scoreText(text) : null;
      decision.tailoredAts = tAts;
      if (tAts) await updateResumeScoring(deps.db, tailored.id, { atsScore: tAts });
      if (tAts && tAts.score >= best.ats_.score) {
        chosen = tailored;
        decision.kept = 'tailored';
      } else {
        decision.note = `tailored skills scored ${tAts?.score ?? 'n/a'} < combo ${best.ats_.score}; using the combo as-is`;
      }
    } else {
      decision.note = `tailored resume ${tailored.status}${tailored.error ? `: ${tailored.error}` : ''}; using the combo as-is`;
    }
  } catch (err) {
    decision.note = `skills rewrite failed (${(err as Error).message}); using the combo as-is`;
    deps.log.warn({ jobId, err: (err as Error).message }, 'selector: per-job skills rewrite failed');
  }

  await setJobResume(deps.db, { jobId, variantId: chosen.id, comboVariantId: best.variantId, selectorScore: best.score, decision });
  await appendEvent(deps.db, {
    kind: 'resume.selected',
    subjectType: 'job',
    subjectId: jobId,
    payload: { variantId: chosen.id, comboVariantId: best.variantId, kept: decision.kept, score: best.score, weakFit: decision.weakFit },
  });
  return { variant: chosen, decision, cached: false };
}

async function generateForJob(
  deps: LibraryDeps,
  job: Job,
  atsType: AtsProfileType,
  scoreText: (text: string) => AtsScore,
): Promise<SelectResult> {
  const r = await runTailor(deps, { jobId: job.id });
  const decision: SelectorDecision = {
    atsType,
    category: null,
    candidates: [],
    comboVariantId: null,
    comboAts: null,
    tailoredVariantId: r.variant.id,
    tailoredAts: null,
    kept: 'generated',
    weakFit: false,
    note: 'resume library is empty; generated a resume for this job',
  };
  if (r.variant.status === 'rendered') {
    const { text } = await ensureScoring(deps, r.variant);
    if (text) {
      decision.tailoredAts = scoreText(text);
      await updateResumeScoring(deps.db, r.variant.id, { atsScore: decision.tailoredAts });
    }
    await setJobResume(deps.db, { jobId: job.id, variantId: r.variant.id, comboVariantId: null, selectorScore: decision.tailoredAts?.score ?? null, decision });
    await appendEvent(deps.db, { kind: 'resume.selected', subjectType: 'job', subjectId: job.id, payload: { variantId: r.variant.id, kept: 'generated' } });
  }
  return { variant: r.variant, decision, cached: false };
}

async function jobVector(deps: LibraryDeps, job: Job): Promise<number[] | null> {
  const stored = await getJobEmbedding(deps.db, job.id);
  if (stored) return stored;
  if (!deps.embed) return null;
  const [v] = await deps.embed.embed([jobEmbeddingText({ title: job.title, company: job.company, locations: job.locations, descriptionMd: job.descriptionMd })]);
  return v ?? null;
}
