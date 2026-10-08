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
  type AnyPgColumn,
  index,
  vector,
  uniqueIndex,
  pgEnum,
  date,
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
  // Phase 6/7: GCC-heavy ATSs.
  'workday',
  'smartrecruiters',
  'successfactors',
  'taleo',
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
    // Phase 3: where and how this company receives email (filled by the contacts enricher).
    emailDomain: text('email_domain'),
    mxHosts: text('mx_hosts').array(),
    mxCheckedAt: timestamp('mx_checked_at', { withTimezone: true }),
    emailPattern: text('email_pattern'),
    emailPatternConfidence: real('email_pattern_confidence'),
    // Phase 6: provenance for discovered companies (null = imported/manual).
    /** e.g. `list:yc`, `list:gcc-journal`, `csv`, `manual`. */
    discoveredVia: text('discovered_via'),
    // Phase 8: LinkedIn company identity (for people search).
    linkedinId: text('linkedin_id'),
    linkedinSlug: text('linkedin_slug'),
    discoveredAt: timestamp('discovered_at', { withTimezone: true }),
    /** Last time `discover_ats` looked at this company (hit or miss). */
    atsCheckedAt: timestamp('ats_checked_at', { withTimezone: true }),
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
    /** Per-target plugin options (Workday searchText/locations, ...); passed through as SourceTarget.options. */
    config: jsonb('config').notNull().default(sql`'{}'::jsonb`),
    /** How the source was found: csv | discover_ats | manual. */
    detectedBy: text('detected_by'),
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
    /** Why the job closed: gone (left every board) | deadline (inferred deadline passed) | manual. */
    closedReason: text('closed_reason'),
    // Phase 10: deadline inference (LLM + web search).
    inferredDeadline: date('inferred_deadline'),
    deadlineConfidence: real('deadline_confidence'),
    deadlineRationale: text('deadline_rationale'),
    /** URLs the estimate cites. */
    deadlineSources: jsonb('deadline_sources'),
    deadlineInferredAt: timestamp('deadline_inferred_at', { withTimezone: true }),
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
    /** Self-reported LLM confidence 0..1; the autopilot gates on this. */
    confidence: real('confidence'),
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

// ---------------------------------------------------------------------------
// Phase 3: contacts, review queue, actions, outreach threads
// ---------------------------------------------------------------------------

export const contactStatusEnum = pgEnum('contact_status', ['active', 'bounced', 'do_not_contact']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role'),
    email: text('email'),
    /** 0..1. 1 = user-supplied or proven by a reply; inferred addresses are lower. */
    emailConfidence: real('email_confidence'),
    /** manual | pattern:<pattern> | provider:<plugin id> */
    emailSource: text('email_source'),
    linkedinUrl: text('linkedin_url'),
    /** Who added the contact: manual | pattern | linkedin | <plugin id>. */
    source: text('source').notNull().default('manual'),
    // Phase 8: referral targeting hints (from the LinkedIn headline / manual entry).
    /** engineer | manager | recruiter | leader | other */
    roleHint: text('role_hint'),
    /** junior | mid | senior | staff | exec */
    seniorityHint: text('seniority_hint'),
    department: text('department'),
    /** Ranked alternative addresses [{ email, confidence, pattern }] from the pattern enricher. */
    emailCandidates: jsonb('email_candidates').notNull().default(sql`'[]'::jsonb`),
    /** Addresses that bounced; never set again (the enricher would otherwise re-pick its top guess). */
    bouncedEmails: text('bounced_emails').array().notNull().default(sql`'{}'::text[]`),
    status: contactStatusEnum('status').notNull().default('active'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A LinkedIn profile identifies a person; the name only does when there is no profile
    // (two "Rahul Sharma"s at one company are two contacts).
    companyNameUniq: uniqueIndex('contacts_company_name_uniq')
      .on(t.companyId, sql`lower(${t.name})`)
      .where(sql`${t.linkedinUrl} is null`),
    companyLinkedinUniq: uniqueIndex('contacts_company_linkedin_uniq')
      .on(t.companyId, t.linkedinUrl)
      .where(sql`${t.linkedinUrl} is not null`),
    emailIdx: index('contacts_email_idx').on(sql`lower(${t.email})`),
  }),
);

/** attention (Phase 9): a human must fix something (e.g. a LinkedIn checkpoint) before a paused loop resumes. */
export const reviewKindEnum = pgEnum('review_kind', ['application', 'outreach', 'followup', 'referral_ask', 'attention']);

export const batchStatusEnum = pgEnum('referral_batch_status', ['drafting', 'pending_review', 'sending', 'sent', 'replied', 'closed']);

/**
 * Phase 8: one referral fan-out per job — N `referral_ask` review items to
 * distinct contacts (email and LinkedIn). A reply on any item marks the batch
 * `replied` and stops that batch's follow-ups.
 */
export const jobReferralBatches = pgTable(
  'job_referral_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    requestedCount: integer('requested_count').notNull().default(10),
    draftedCount: integer('drafted_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    repliedCount: integer('replied_count').notNull().default(0),
    status: batchStatusEnum('status').notNull().default('drafting'),
    firstSentAt: timestamp('first_sent_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobUniq: uniqueIndex('job_referral_batches_job_uniq').on(t.jobId),
  }),
);
export const reviewStatusEnum = pgEnum('review_status', [
  'pending',
  'approved',
  'rejected',
  'executed',
  'failed',
  'cancelled',
]);

/**
 * The human approval queue. Nothing with an external side effect runs without
 * an `approved` row here; the core builds the ApprovedDraft from it.
 */
export const reviewItems = pgTable(
  'review_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: reviewKindEnum('kind').notNull(),
    status: reviewStatusEnum('status').notNull().default('pending'),
    /** The actor that will execute it. */
    pluginId: text('plugin_id').notNull(),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    /** Follow-ups point at the outreach thread they continue. */
    threadId: uuid('thread_id').references((): AnyPgColumn => outreachThreads.id, { onDelete: 'set null' }),
    /** Phase 8: the referral fan-out this item belongs to. */
    batchId: uuid('batch_id').references((): AnyPgColumn => jobReferralBatches.id, { onDelete: 'set null' }),
    draft: jsonb('draft').notNull(),
    /** As the actor prepared it, before human edits. */
    originalDraft: jsonb('original_draft').notNull(),
    /** Explicit per-item override of the "2 people per company per week" cap. */
    overrideCompanyCap: boolean('override_company_cap').notNull().default(false),
    /** Not sent before this time (follow-ups). */
    notBefore: timestamp('not_before', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    /** 'human' | 'autopilot' — who approved/rejected this item. Null while pending. */
    decidedBy: text('decided_by'),
    /** Composite LLM confidence 0..1 used by the autopilot (min across match, tailor, draft). */
    confidence: real('confidence'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('review_items_status_idx').on(t.status, t.createdAt),
    contactIdx: index('review_items_contact_idx').on(t.contactId),
    batchIdx: index('review_items_batch_idx').on(t.batchId),
  }),
);

export const actionStatusEnum = pgEnum('action_status', ['started', 'succeeded', 'failed']);

/** One row per execute() attempt. The idempotency key makes a completed side effect unrepeatable. */
export const actions = pgTable(
  'actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    reviewItemId: uuid('review_item_id')
      .notNull()
      .references(() => reviewItems.id, { onDelete: 'cascade' }),
    pluginId: text('plugin_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: actionStatusEnum('status').notNull(),
    dryRun: boolean('dry_run').notNull(),
    result: jsonb('result'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
  },
  (t) => ({
    keyUniq: uniqueIndex('actions_idempotency_key_uniq').on(t.idempotencyKey),
    reviewIdx: index('actions_review_item_idx').on(t.reviewItemId),
    executedIdx: index('actions_executed_idx').on(t.executedAt),
  }),
);

export const threadStateEnum = pgEnum('thread_state', ['sent', 'replied', 'bounced', 'closed']);

export const outreachThreads = pgTable(
  'outreach_threads',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    /** The review item of the first email. */
    reviewItemId: uuid('review_item_id').references((): AnyPgColumn => reviewItems.id, { onDelete: 'set null' }),
    /** Gmail thread id, or `linkedin:<profile>` for LinkedIn conversations (see `channel`). */
    gmailThreadId: text('gmail_thread_id').notNull(),
    /** Phase 8/9: email | linkedin */
    channel: text('channel').notNull().default('email'),
    subject: text('subject').notNull(),
    /** RFC 5322 Message-IDs we sent, oldest first (for In-Reply-To / References). */
    messageIds: text('message_ids').array().notNull().default(sql`'{}'::text[]`),
    state: threadStateEnum('state').notNull().default('sent'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull(),
    followupsSent: integer('followups_sent').notNull().default(0),
    nextFollowupAt: timestamp('next_followup_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    gmailThreadUniq: uniqueIndex('outreach_threads_gmail_thread_uniq').on(t.gmailThreadId),
    stateIdx: index('outreach_threads_state_idx').on(t.state, t.nextFollowupAt),
  }),
);

/** Small key/value store for scheduler state (e.g. the next allowed send time). Never secrets. */
export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Phase 4: tailored resumes
// ---------------------------------------------------------------------------

export const resumeStatusEnum = pgEnum('resume_status', ['rendered', 'validation_failed', 'render_failed']);

/**
 * A grounded resume variant for one job. Bullets cite the profile fact ids they
 * came from; the validator rejects any claim not present in the source fact.
 * `pdfPath` is null when Typst wasn't available (or render failed) but the
 * bullets + validation report still live here so the user can see why.
 */
export const resumeVariants = pgTable(
  'resume_variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileVersion: text('profile_version').notNull(),
    pluginId: text('plugin_id').notNull(),
    templateId: text('template_id').notNull(),
    /** Facts the LLM selected, in display order. */
    factIds: text('fact_ids').array().notNull().default(sql`'{}'::text[]`),
    /** Rendered bullets: [{ factId, text, section }, ...] (jsonb for forward compat). */
    bullets: jsonb('bullets').notNull(),
    /** Headline fields (summary, headline, selected skills) the LLM wrote. */
    header: jsonb('header').notNull(),
    /** [{ factId, text, status: ok|warning|error, issues: string[] }, ...]. */
    validationReport: jsonb('validation_report').notNull(),
    status: resumeStatusEnum('status').notNull(),
    /** Absolute PDF path on disk (served through the API). Null when render failed or Typst missing. */
    pdfPath: text('pdf_path'),
    pdfBytes: integer('pdf_bytes'),
    provider: text('provider'),
    model: text('model'),
    error: text('error'),
    /** Self-reported LLM confidence 0..1 (penalised by the validator); the autopilot gates on this. */
    confidence: real('confidence'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('resume_variants_job_idx').on(t.jobId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Phase 12: autopilot sequencing (referral-first, apply-on-deadline)
// ---------------------------------------------------------------------------

export const pipelineStateEnum = pgEnum('pipeline_state', ['candidate', 'referral_pending', 'ready_to_apply', 'applied', 'expired', 'failed']);

/**
 * One row per job the sequencer has taken on. Transitions are guarded
 * (`where state = from`) so a restarted run never repeats a step; the full
 * history lives in `events` (kind = pipeline.transition, subject = job).
 */
export const jobPipelineState = pgTable(
  'job_pipeline_state',
  {
    jobId: uuid('job_id')
      .primaryKey()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    state: pipelineStateEnum('state').notNull(),
    enteredStateAt: timestamp('entered_state_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last transition reason, counts, review item ids, manual flags. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateIdx: index('job_pipeline_state_state_idx').on(t.state, t.enteredStateAt),
  }),
);
