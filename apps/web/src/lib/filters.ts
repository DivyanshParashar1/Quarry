// Dashboard filter state <-> URL query string <-> /api/jobs params. Pure, so it's unit tested.

export type View = 'ranked' | 'all' | 'unscored' | 'excluded';
export type RemotePolicy = 'remote' | 'hybrid' | 'onsite';

export interface Filters {
  view: View;
  q: string;
  company: string;
  location: string;
  remote: RemotePolicy[];
  minScore: number | null;
  sort: 'score' | 'posted';
}

export const DEFAULT_FILTERS: Filters = {
  view: 'ranked',
  q: '',
  company: '',
  location: '',
  remote: [],
  minScore: null,
  sort: 'score',
};

const VIEWS: View[] = ['ranked', 'all', 'unscored', 'excluded'];
const REMOTE: RemotePolicy[] = ['remote', 'hybrid', 'onsite'];

export function filtersFromSearch(search: string): Filters {
  const p = new URLSearchParams(search);
  const view = p.get('view') as View | null;
  const minScore = Number(p.get('min'));
  return {
    view: view && VIEWS.includes(view) ? view : DEFAULT_FILTERS.view,
    q: p.get('q') ?? '',
    company: p.get('company') ?? '',
    location: p.get('location') ?? '',
    remote: (p.get('remote') ?? '').split(',').filter((r): r is RemotePolicy => REMOTE.includes(r as RemotePolicy)),
    minScore: p.has('min') && Number.isFinite(minScore) ? Math.min(100, Math.max(0, Math.round(minScore))) : null,
    sort: p.get('sort') === 'posted' ? 'posted' : 'score',
  };
}

/** Only non-default values, so URLs stay short. `job` is the selected job id. */
export function filtersToSearch(f: Filters, job: string | null): string {
  const p = new URLSearchParams();
  if (f.view !== DEFAULT_FILTERS.view) p.set('view', f.view);
  if (f.q) p.set('q', f.q);
  if (f.company) p.set('company', f.company);
  if (f.location) p.set('location', f.location);
  if (f.remote.length) p.set('remote', f.remote.join(','));
  if (f.minScore !== null) p.set('min', String(f.minScore));
  if (f.sort !== 'score') p.set('sort', f.sort);
  if (job) p.set('job', job);
  const s = p.toString();
  return s ? `?${s}` : '';
}

const VIEW_METHODS: Record<View, string | null> = {
  ranked: 'llm',
  all: null,
  unscored: 'unscored',
  excluded: 'filtered,prefilter',
};

export function apiParams(f: Filters, limit: number, offset: number): URLSearchParams {
  const p = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: f.sort });
  const method = VIEW_METHODS[f.view];
  if (method) p.set('method', method);
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.company.trim()) p.set('company', f.company.trim());
  if (f.location.trim()) p.set('location', f.location.trim());
  if (f.remote.length) p.set('remote', f.remote.join(','));
  if (f.minScore !== null) p.set('minScore', String(f.minScore));
  return p;
}

export function scoreTone(score: number | null, method: string | null): 'good' | 'ok' | 'weak' | 'none' {
  if (method !== 'llm' || score === null) return 'none';
  if (score >= 75) return 'good';
  if (score >= 50) return 'ok';
  return 'weak';
}
