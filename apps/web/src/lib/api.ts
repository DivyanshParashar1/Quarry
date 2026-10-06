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
export async function send<T>(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown = {}): Promise<T> {
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

export interface EmailDraft {
  to: string;
  toName: string;
  subject: string;
  body: string;
  factIds: string[];
  gmailThreadId: string | null;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'cancelled';

export interface ReviewItem {
  id: string;
  kind: 'application' | 'outreach' | 'followup';
  status: ReviewStatus;
  draft: EmailDraft;
  originalDraft: EmailDraft;
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

export type ResumeStatus = 'rendered' | 'validation_failed' | 'render_failed';

export interface ValidationIssue {
  kind: 'unknown_fact_id' | 'invented_number' | 'invented_term' | 'too_long' | 'empty';
  detail: string;
}

export interface FactValidation {
  factId: string;
  text: string;
  section: string;
  status: 'ok' | 'warning' | 'error';
  issues: ValidationIssue[];
}

export interface TailoredBullet {
  factId: string;
  text: string;
  section: string;
}

export interface ResumeVariant {
  id: string;
  jobId: string;
  profileVersion: string;
  pluginId: string;
  templateId: string;
  factIds: string[];
  bullets: TailoredBullet[];
  header: { summary: string; skills: string[] };
  validationReport: FactValidation[];
  status: ResumeStatus;
  pdfPath: string | null;
  pdfBytes: number | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  createdAt: string;
}
