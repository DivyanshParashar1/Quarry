import { z } from 'zod';
import type { Embedder, LLMClient, Logger, Profile } from '@jobforge/shared';

export type { Embedder, LLMClient, LLMRequest, LLMResponse, LLMTask, Profile, ProfileFact, Preferences } from '@jobforge/shared';
export { factSchema, preferencesSchema } from '@jobforge/shared';
import type { PluginManifest } from './manifest.js';

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
}

// Placeholders for capabilities that land in later phases. Kept as opaque
// interfaces so the context shape is stable now.
export interface BrowserHandle {
  readonly kind: 'browser';
}
export interface GmailHandle {
  readonly kind: 'gmail';
}

export interface PluginContext<C> {
  config: C;
  http: ScopedHttp;
  /** Present only when the manifest declares `permissions.llm`. */
  llm?: LLMClient;
  embed?: Embedder;
  browser?: BrowserHandle;
  gmail?: GmailHandle;
  log: Logger;
  signal: AbortSignal;
  dryRun: boolean;
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
  payload: z.unknown(),
});
export type RawPosting = z.infer<typeof rawPostingSchema>;

// ---------------------------------------------------------------------------
// Domain shapes used by later stages. Minimal for now; grown per phase.
// ---------------------------------------------------------------------------

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  tags: string[];
}

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

export type Enrichment = Record<string, unknown>;

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
}
export type TailoredArtifacts = Record<string, unknown>;
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
export interface EnricherPlugin<C = unknown> extends BasePlugin {
  enrich(ctx: PluginContext<C>, job: Job, company: Company): Promise<Enrichment>;
}
export interface MatcherPlugin<C = unknown> extends BasePlugin {
  score(ctx: PluginContext<C>, jobs: Job[], profile: Profile): Promise<MatchResult[]>;
}
export interface TailorPlugin<C = unknown> extends BasePlugin {
  tailor(ctx: PluginContext<C>, job: Job, profile: Profile): Promise<TailoredArtifacts>;
}
export interface ActorPlugin<C = unknown> extends BasePlugin {
  prepare(ctx: PluginContext<C>, input: ActionInput): Promise<ActionDraft>;
  execute(ctx: PluginContext<C>, draft: ApprovedDraft, idempotencyKey: string): Promise<ActionResult>;
}
export interface TrackerPlugin<C = unknown> extends BasePlugin {
  poll(ctx: PluginContext<C>, since: Date): AsyncIterable<TrackEvent>;
}

export type AnyPlugin =
  | SourcePlugin
  | EnricherPlugin
  | MatcherPlugin
  | TailorPlugin
  | ActorPlugin
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
