import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  boolean,
  index,
  vector,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

// Phase 0/1: companies, company_sources, raw_postings, jobs, plugin_runs, events.
// Phase 2: jobs.embedding, profile_facts, profile_snapshots, match_results, llm_calls.
// Later phases add resume_variants, contacts, review_items, actions, outreach_threads
// (see PLAN.md section 7).

/** bge-small-en-v1.5 output size; must match @jobforge/embeddings. */
export const EMBEDDING_DIM = 384;

export const atsTypeEnum = pgEnum('ats_type', [
  'greenhouse',
  'lever',
  'ashby',
  'careers_page',
  'other',
]);

export const sourceStatusEnum = pgEnum('source_status', ['active', 'paused', 'error']);

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    domain: text('domain'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    location: text('location'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: uniqueIndex('companies_name_uniq').on(t.name),
    domainIdx: index('companies_domain_idx').on(t.domain),
  }),
);

export const companySources = pgTable(
  'company_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    atsType: atsTypeEnum('ats_type').notNull(),
    boardToken: text('board_token'),
    status: sourceStatusEnum('status').notNull().default('active'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyAtsUniq: uniqueIndex('company_sources_company_ats_token_uniq').on(
      t.companyId,
      t.atsType,
      t.boardToken,
    ),
  }),
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    normalizedTitle: text('normalized_title').notNull(),
    locations: text('locations').array().notNull().default(sql`'{}'::text[]`),
    remotePolicy: text('remote_policy'),
    seniority: text('seniority'),
    descriptionMd: text('description_md'),
    applyUrl: text('apply_url'),
    fingerprint: text('fingerprint').notNull(),
    // Cleared whenever the description changes so the job is re-embedded.
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    fingerprintUniq: uniqueIndex('jobs_fingerprint_uniq').on(t.fingerprint),
    companyIdx: index('jobs_company_idx').on(t.companyId),
    embeddingIdx: index('jobs_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  }),
);

export const rawPostings = pgTable(
  'raw_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourcePlugin: text('source_plugin').notNull(),
    companySourceId: uuid('company_source_id').references(() => companySources.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    url: text('url'),
    payload: jsonb('payload').notNull(),
    fingerprint: text('fingerprint').notNull(),
    canonicalJobId: uuid('canonical_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    // Bumped every time a fetch sees this posting; used to close jobs that disappear from a board.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companySourceIdx: index('raw_postings_company_source_idx').on(t.companySourceId),
    canonicalJobIdx: index('raw_postings_canonical_job_idx').on(t.canonicalJobId),
    sourceExternalUniq: uniqueIndex('raw_postings_source_external_uniq').on(
      t.sourcePlugin,
      t.externalId,
    ),
    fingerprintIdx: index('raw_postings_fingerprint_idx').on(t.fingerprint),
  }),
);

export const pluginRuns = pgTable(
  'plugin_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    pluginId: text('plugin_id').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull(), // started | succeeded | failed
    targetKey: text('target_key'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    itemsIn: integer('items_in').notNull().default(0),
    itemsOut: integer('items_out').notNull().default(0),
    error: text('error'),
    meta: jsonb('meta'),
  },
  (t) => ({
    pluginIdx: index('plugin_runs_plugin_idx').on(t.pluginId),
    startedIdx: index('plugin_runs_started_idx').on(t.startedAt),
  }),
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindIdx: index('events_kind_idx').on(t.kind),
    createdIdx: index('events_created_idx').on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Phase 2: profile, matching, LLM call log
// ---------------------------------------------------------------------------

export const factKindEnum = pgEnum('fact_kind', ['project', 'experience', 'education', 'skill', 'achievement']);

/**
 * One row per fact in profile/facts.yaml, keyed by the fact's own stable id so
 * tailored bullets can cite it. Facts removed from the YAML are retired, not deleted.
 */
export const profileFacts = pgTable(
  'profile_facts',
  {
    id: text('id').primaryKey(),
    kind: factKindEnum('kind').notNull(),
    content: text('content').notNull(),
    metrics: jsonb('metrics').notNull().default(sql`'{}'::jsonb`),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Bumped whenever content/metrics/tags change. */
    version: integer('version').notNull().default(1),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    kindIdx: index('profile_facts_kind_idx').on(t.kind),
  }),
);

/**
 * A loaded profile (facts + preferences), keyed by a content hash. Match results
 * reference the version they were scored against; the active profile is the one
 * loaded most recently.
 */
export const profileSnapshots = pgTable('profile_snapshots', {
  version: text('version').primaryKey(),
  preferences: jsonb('preferences').notNull(),
  factIds: text('fact_ids').array().notNull().default(sql`'{}'::text[]`),
  /** The text that was embedded for the job-similarity prefilter. */
  summary: text('summary').notNull(),
  embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const matchMethodEnum = pgEnum('match_method', ['filtered', 'prefilter', 'llm']);

export const matchResults = pgTable(
  'match_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileVersion: text('profile_version').notNull(),
    pluginId: text('plugin_id').notNull(),
    /** filtered = failed a hard filter; prefilter = cut by embedding similarity; llm = scored by the rubric. */
    method: matchMethodEnum('method').notNull(),
    score: integer('score').notNull(),
    similarity: real('similarity'),
    rubric: jsonb('rubric').notNull().default(sql`'{}'::jsonb`),
    reasons: text('reasons').notNull(),
    provider: text('provider'),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobProfileUniq: uniqueIndex('match_results_job_profile_uniq').on(t.jobId, t.profileVersion),
    profileScoreIdx: index('match_results_profile_score_idx').on(t.profileVersion, t.score),
  }),
);

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    task: text('task').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    success: boolean('success').notNull(),
    attempts: integer('attempts').notNull().default(1),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: real('cost_usd'),
    latencyMs: integer('latency_ms').notNull(),
    error: text('error'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index('llm_calls_created_idx').on(t.createdAt),
    taskIdx: index('llm_calls_task_idx').on(t.task),
  }),
);
