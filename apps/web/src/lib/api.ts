// Response shapes of apps/server/src/api.ts (dates arrive as ISO strings).

export type MatchMethod = 'llm' | 'prefilter' | 'filtered';

export interface JobRow {
  id: string;
  company: string;
  title: string;
  locations: string[];
  remotePolicy: string | null;
  seniority: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  closedAt: string | null;
  score: number | null;
  method: MatchMethod | null;
  similarity: number | null;
  reasons: string | null;
}

export interface JobsPage {
  total: number;
  profileVersion: string | null;
  rows: JobRow[];
}

export interface Rubric {
  stack_fit?: number;
  seniority_fit?: number;
  location_fit?: number;
  eligibility?: number;
  concerns?: string[];
  stage?: string;
  rank?: number;
}

export interface JobDetail {
  id: string;
  company: { id: string; name: string; domain: string | null; tags: string[] };
  title: string;
  locations: string[];
  remotePolicy: string | null;
  seniority: string | null;
  descriptionMd: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  match: {
    profileVersion: string;
    method: MatchMethod;
    score: number;
    similarity: number | null;
    rubric: Rubric;
    reasons: string;
    provider: string | null;
    model: string | null;
    createdAt: string;
  } | null;
  sources: { sourcePlugin: string; externalId: string; url: string | null; lastSeenAt: string }[];
}

export interface Stats {
  profile: { version: string; facts: number; roles: string[] } | null;
  match: { openJobs: number; embedded: number; scored: Record<MatchMethod, number>; unscored: number };
  llm24h: { calls: number; failed: number; costUsd: number; promptTokens: number; completionTokens: number };
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return (await res.json()) as T;
}

/** Writes carry x-jobforge: 1; the server refuses state changes without it (CSRF guard). */
export async function send<T>(path: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-jobforge': '1' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string; issues?: string[] };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? data.issues?.join('; ') ?? res.statusText);
  return data;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Multipart upload (same CSRF guard as `send`). */
export async function upload<T>(path: string, file: File, field = 'file'): Promise<T> {
  const form = new FormData();
  form.append(field, file);
  const res = await fetch(path, { method: 'POST', headers: { accept: 'application/json', 'x-jobforge': '1' }, body: form });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText);
  return data;
}

export interface EmailDraft {
  to: string;
  toName: string;
  subject: string;
  body: string;
  factIds: string[];
  gmailThreadId: string | null;
  resumeBulletId?: string | null;
}

/** Phase 8/9: a LinkedIn connection request with a note. */
export interface LinkedInNoteDraft {
  channel: 'linkedin';
  profileUrl: string;
  toName: string;
  note: string;
  jobUrl: string | null;
  confidence: number | null;
}

/** Phase 9: something a human must fix (e.g. a LinkedIn checkpoint). */
export interface AttentionDraft {
  title: string;
  message: string;
  reason: string;
  url: string | null;
}

export type AnyDraft = EmailDraft | LinkedInNoteDraft | AttentionDraft | Record<string, unknown>;

export const isLinkedInDraft = (d: AnyDraft): d is LinkedInNoteDraft => (d as LinkedInNoteDraft).channel === 'linkedin';
export const isEmailDraft = (d: AnyDraft): d is EmailDraft => typeof (d as EmailDraft).to === 'string' && typeof (d as EmailDraft).body === 'string';

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'cancelled';

export type ReviewKind = 'application' | 'outreach' | 'followup' | 'referral_ask' | 'attention';

/** An email review item (the common case); see ReviewItemAny for the other drafts. */
export interface ReviewItem extends Omit<ReviewItemAny, 'draft' | 'originalDraft'> {
  draft: EmailDraft;
  originalDraft: EmailDraft;
}

export interface ReviewItemAny {
  id: string;
  kind: ReviewKind;
  pluginId: string;
  batchId: string | null;
  decidedBy: string | null;
  status: ReviewStatus;
  draft: AnyDraft;
  originalDraft: AnyDraft;
  overrideCompanyCap: boolean;
  decisionNote: string | null;
  error: string | null;
  editedAt: string | null;
  createdAt: string;
  contactName: string | null;
  contactEmail: string | null;
  contactEmailConfidence: number | null;
  companyName: string | null;
  jobTitle: string | null;
  jobId: string | null;
}

export interface Contact {
  id: string;
  companyId: string;
  name: string;
  role: string | null;
  email: string | null;
  emailConfidence: number | null;
  emailSource: string | null;
  status: 'active' | 'bounced' | 'do_not_contact';
}

export interface Thread {
  id: string;
  state: 'sent' | 'replied' | 'bounced' | 'closed';
  subject: string;
  sentAt: string;
  followupsSent: number;
  nextFollowupAt: string | null;
  contactName: string;
  contactEmail: string | null;
}

export interface JobOutreach {
  company: { id: string; name: string; domain: string | null; emailDomain: string | null; emailPattern: string | null; emailPatternConfidence: number | null };
  contacts: Contact[];
  reviewItems: ReviewItem[];
  threads: Thread[];
}

export interface Pipeline {
  review: Record<ReviewStatus, number>;
  threads: Record<Thread['state'], number>;
}

export const FACT_KINDS = ['project', 'experience', 'education', 'skill', 'achievement'] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface ProfileFact {
  id: string;
  kind: FactKind;
  content: string;
  metrics: Record<string, string | number | boolean>;
  tags: string[];
}

export interface Preferences {
  roles: string[];
  seniority: string[];
  locations: string[];
  remote_policy: ('remote' | 'hybrid' | 'onsite')[];
  stack: string[];
  salary_floor: { amount: number; currency: string; period: 'year' | 'month' } | null;
  experience_years: number | null;
  graduation_year: number | null;
  exclusions: { companies: string[]; title_keywords: string[]; description_keywords: string[] };
  notes: string | null;
}

export interface FullProfile {
  facts: ProfileFact[];
  preferences: Preferences;
}

export interface FactDraft {
  id: string;
  kind: FactKind;
  content: string;
  metrics: Record<string, string | number | boolean>;
  tags: string[];
}

// Resume variants moved to a block-based model: the tailor plugin assembles
// LaTeX fragments from profile/resume/blocks/ and only an LLM-authored rewrite
// changes individual bullet text. The server still returns the pre-migration
// row shape (fact_ids/bullets/header columns reused as metadata carriers)
// until the Phase 2 DB migration lands.
// Resume block editor (GET/POST/PUT/DELETE /api/resume/*).

export interface ResumeBullet {
  id: string;
  tags?: string[];
}

export interface ResumeBlock {
  id: string;
  file: string;
  section: string;
  title?: string;
  always_include?: boolean;
  tags?: string[];
  tech_stack_line?: string;
  bullets?: ResumeBullet[];
}

export interface ResumeSectionWrapper {
  header: string;
  inner_start: string;
  inner_end: string;
  separator: string;
}

export interface ResumeManifest {
  sections_order: string[];
  sections: Record<string, ResumeSectionWrapper>;
  header_block: string;
  blocks: ResumeBlock[];
  budget: {
    experience_blocks?: { min: number; max: number };
    project_blocks?: { min: number; max: number };
    total_bullets_hint?: number;
  };
}

export interface ResumeData {
  manifest: ResumeManifest;
  fragments: Record<string, string>;
  preamble: string;
}

export type ResumeStatus = 'rendered' | 'validation_failed' | 'render_failed';

export interface GuardrailIssue {
  kind: 'invented_number' | 'invented_term' | 'too_long' | 'empty' | 'unknown_bullet_id' | 'unknown_block_id';
  detail: string;
}

export interface RewriteValidation {
  bullet_id: string;
  original: string;
  rewritten: string;
  status: 'ok' | 'warning' | 'error';
  issues: GuardrailIssue[];
  reverted: boolean;
}

export interface BulletRewrite {
  bullet_id: string;
  original: string;
  rewritten: string;
  reason: string;
}

export interface ResumeVariantMeta {
  selectedBlockIds: string[];
  texPath: string;
  pages: number | null;
}

export interface ResumeVariantRewrites {
  rewrites: BulletRewrite[];
  techStackRewrites: { block_id: string; original: string; rewritten: string }[];
  skillsReorder: { group: string; ordered: string[] }[];
  rationale: string;
}

export interface ResumeVariant {
  id: string;
  jobId: string;
  profileVersion: string;
  pluginId: string;
  templateId: string;
  /** Retired column; always empty under the block-based tailor. */
  factIds: string[];
  /** Reused `bullets` jsonb column — now carries block/path/page metadata. */
  bullets: ResumeVariantMeta;
  /** Reused `header` jsonb column — now carries the selection's rewrites. */
  header: ResumeVariantRewrites;
  validationReport: RewriteValidation[];
  status: ResumeStatus;
  pdfPath: string | null;
  pdfBytes: number | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Phase 8: referral fan-out
// ---------------------------------------------------------------------------

export type BatchStatus = 'drafting' | 'pending_review' | 'sending' | 'sent' | 'replied' | 'closed';

export interface ReferralBatch {
  id: string;
  jobId: string;
  requestedCount: number;
  draftedCount: number;
  sentCount: number;
  repliedCount: number;
  status: BatchStatus;
  firstSentAt: string | null;
  repliedAt: string | null;
  note: string | null;
}

export interface ReferralItem {
  id: string;
  status: ReviewStatus;
  pluginId: string;
  channel: 'email' | 'linkedin';
  contactId: string | null;
  contactName: string | null;
  contactRole: string | null;
  contactEmail: string | null;
  linkedinUrl: string | null;
  threadState: 'sent' | 'replied' | 'bounced' | 'closed' | null;
  decidedBy: string | null;
  error: string | null;
  createdAt: string;
}

export interface ReferralPanelData {
  batch: ReferralBatch | null;
  items: ReferralItem[];
}

export interface FanOutResponse {
  drafted: { reviewItemId: string; contactId: string; channel: 'email' | 'linkedin' }[];
  skipped: { contactId: string; name: string; reason: string }[];
  shortBy: number;
  foundContacts: number;
  panel: ReferralPanelData;
}
