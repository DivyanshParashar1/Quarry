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
