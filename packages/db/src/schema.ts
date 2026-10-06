import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  uniqueIndex,
  pgEnum,
} from 'drizzle-orm/pg-core';

// Phase 0 covers: companies, company_sources, raw_postings, jobs, plugin_runs, events.
// Later phases add match_results, profile_facts, resume_variants, contacts, review_items,
// actions, outreach_threads, llm_calls (see PLAN.md section 7).

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
    // embedding vector(384) added via raw SQL in a later migration (requires pgvector type)
    postedAt: timestamp('posted_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({
    fingerprintUniq: uniqueIndex('jobs_fingerprint_uniq').on(t.fingerprint),
    companyIdx: index('jobs_company_idx').on(t.companyId),
  }),
);

export const rawPostings = pgTable(
  'raw_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourcePlugin: text('source_plugin').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),
    payload: jsonb('payload').notNull(),
    fingerprint: text('fingerprint').notNull(),
    canonicalJobId: uuid('canonical_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
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
