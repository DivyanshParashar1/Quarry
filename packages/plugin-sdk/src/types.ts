import { z } from 'zod';
import type { Embedder, LLMClient, Logger, Profile } from '@jobforge/shared';

export type { Embedder, LLMClient, LLMRequest, LLMResponse, LLMTask, Profile, ProfileFact, Preferences } from '@jobforge/shared';
export { factSchema, preferencesSchema } from '@jobforge/shared';
import type { PluginManifest } from './manifest.js';
import type { DnsResolver, GmailHandle } from './capabilities.js';
import type { Company, Enrichment } from './outreach.js';

// ---------------------------------------------------------------------------
// Context (PLAN.md §4.2). Constructed by the core only; plugins receive it.
// ---------------------------------------------------------------------------

export interface HttpRequestInit {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Overrides the core's default per-request timeout. */
  timeoutMs?: number;
}

export interface ScopedHttp {
  /** Fetch a URL whose host is in `manifest.permissions.domains`. Retries transient failures. */
  request(url: string, init?: HttpRequestInit): Promise<Response>;
  /** `request` + status check + JSON parse. Throws `HttpError` on non-2xx. */
  getJson<T = unknown>(url: string, init?: HttpRequestInit): Promise<T>;
  /** `request` + status check, returning the body as text (HTML/XML pages). Throws `HttpError` on non-2xx. */
  getText(url: string, init?: HttpRequestInit): Promise<string>;
}

import type { BrowserHandle } from './browser.js';
export type { BrowserHandle } from './browser.js';

export interface PluginContext<C> {
  config: C;
  http: ScopedHttp;
  /** Present only when the manifest declares `permissions.llm`. */
  llm?: LLMClient;
  embed?: Embedder;
  browser?: BrowserHandle;
  /** Scoped to the manifest's `permissions.gmail`. */
  gmail?: GmailHandle;
  /** Present only when the manifest declares `permissions.dns`. */
  dns?: DnsResolver;
  log: Logger;
  signal: AbortSignal;
  dryRun: boolean;
  /**
   * Append an audit event (stored as `plugin.<id>.<kind>` in `events`). Present
   * when the caller records events; never put secrets or full message bodies here.
   */
  emit?(kind: string, data: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Source stage data
// ---------------------------------------------------------------------------

/** One fetch target, derived from a `company_sources` row. */
export interface SourceTarget {
  companySourceId: string;
  companyId: string;
  companyName: string;
  boardToken: string;
  /**
   * Per-target overrides from `company_sources.config` (e.g. a Workday search
   * text). Each source plugin validates the keys it understands; others are ignored.
   */
  options?: Record<string, unknown>;
}

export const remotePolicySchema = z.enum(['remote', 'hybrid', 'onsite']);
export type RemotePolicy = z.infer<typeof remotePolicySchema>;

/**
 * What a source plugin yields: the posting mapped onto common fields, plus the
 * untouched API object in `payload`. Normalization and dedup happen in the core.
 */
export const rawPostingSchema = z.object({
  externalId: z.string().min(1),
  url: z.string().url().nullable(),
  applyUrl: z.string().url().nullable(),
  title: z.string().min(1),
  locations: z.array(z.string()),
  remotePolicy: remotePolicySchema.nullable(),
  department: z.string().nullable(),
  /** HTML (already entity-decoded) or plain text; the core converts it to markdown. */
  descriptionHtml: z.string().nullable(),
  postedAt: z.date().nullable(),
  /**
   * Employer name, for sources that are not tied to one company (job-alert
   * emails). Company-scoped sources leave it unset; the core uses the target's company.
   */
  companyName: z.string().min(1).optional(),
  payload: z.unknown(),
});
export type RawPosting = z.infer<typeof rawPostingSchema>;

// ---------------------------------------------------------------------------
// Domain shapes used by later stages. Minimal for now; grown per phase.
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  companyId: string;
  company: string;
  title: string;
  normalizedTitle: string;
  locations: string[];
  remotePolicy: RemotePolicy | null;
  seniority: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: Date | null;
  /** Normalized description embedding, when the embed step has run. */
  embedding: number[] | null;
}

export interface MatchResult {
  jobId: string;
  /** 0..100 */
  score: number;
  /** filtered = failed a hard filter; prefilter = cut by similarity; llm = scored by the rubric. */
  method: 'filtered' | 'prefilter' | 'llm';
  similarity: number | null;
  rubric: Record<string, unknown>;
  reasons: string;
  provider: string | null;
  model: string | null;
  /** Self-reported LLM confidence 0..1 (null for deterministic methods). The autopilot gates on this. */
  confidence: number | null;
}
import type { TailoredResume } from './tailor.js';
/** What a tailor plugin returns (PLAN.md §7). See `TailoredResume`. */
export type TailoredArtifacts = TailoredResume;

export type ActionInput = Record<string, unknown>;
export type ActionDraft = Record<string, unknown>;
export type ActionResult = Record<string, unknown>;
export interface TrackEvent {
  kind: string;
  at: Date;
  data: Record<string, unknown>;
}


declare const approvedBrand: unique symbol;
/** Constructed by the core from an approved `review_items` row. Plugins cannot create one. */
export interface ApprovedDraft<T = ActionDraft> {
  readonly reviewItemId: string;
  readonly draft: T;
  readonly [approvedBrand]: true;
}

// ---------------------------------------------------------------------------
// Stage contracts (PLAN.md §4.3)
// ---------------------------------------------------------------------------

interface BasePlugin {
  manifest: PluginManifest;
}

export interface SourcePlugin<C = unknown> extends BasePlugin {
  fetch(ctx: PluginContext<C>, target: SourceTarget): AsyncIterable<RawPosting>;
}
export interface EnricherPlugin<C = unknown, E = Enrichment> extends BasePlugin {
  /** `job` is null when enriching a company outside any particular job. */
  enrich(ctx: PluginContext<C>, job: Job | null, company: Company): Promise<E>;
}
export interface MatcherPlugin<C = unknown> extends BasePlugin {
  score(ctx: PluginContext<C>, jobs: Job[], profile: Profile): Promise<MatchResult[]>;
}
export interface TailorPlugin<C = unknown> extends BasePlugin {
  tailor(ctx: PluginContext<C>, job: Job, profile: Profile): Promise<TailoredArtifacts>;
}
/** I = what prepare() takes, D = the draft it proposes, R = what execute() reports. */
export interface ActorPlugin<C = unknown, I = ActionInput, D = ActionDraft, R = ActionResult> extends BasePlugin {
  /** Proposes a draft. Must not cause any external side effect. */
  prepare(ctx: PluginContext<C>, input: I): Promise<D>;
  /** Only ever called by the core, with a draft built from an approved review item. */
  execute(ctx: PluginContext<C>, draft: ApprovedDraft<D>, idempotencyKey: string): Promise<R>;
  /**
   * Optional dry preview of a draft (e.g. fill a form and screenshot it without
   * submitting). Must not cause an external side effect. Returns screenshot paths.
   */
  preview?(ctx: PluginContext<C>, draft: D): Promise<string[]>;
}
export interface TrackerPlugin<C = unknown> extends BasePlugin {
  poll(ctx: PluginContext<C>, since: Date): AsyncIterable<TrackEvent>;
}

export type AnyPlugin =
  | SourcePlugin
  | EnricherPlugin
  | MatcherPlugin
  | TailorPlugin
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | ActorPlugin<any, any, any, any>
  | TrackerPlugin;

/** The method each stage must implement; the loader checks for it. */
export const stageMethods = {
  source: ['fetch'],
  enricher: ['enrich'],
  matcher: ['score'],
  tailor: ['tailor'],
  actor: ['prepare', 'execute'],
  tracker: ['poll'],
} as const;

/** Phase 10: what the deadline enricher returns for one job. */
export interface DeadlineEstimate {
  /** ISO date (YYYY-MM-DD), or null when no sensible estimate exists. */
  deadline: string | null;
  /** 0..1, already penalised when no web search was available or nothing was cited. */
  confidence: number;
  rationale: string;
  sources: string[];
  searched: boolean;
}
