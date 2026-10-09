import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { FilterBar } from '@/components/FilterBar';
import { JobDetail } from '@/components/JobDetail';
import { JobList } from '@/components/JobList';
import { ProfilePage } from '@/components/ProfilePage';
import { ApplicationsPage } from '@/components/ApplicationsPage';
import { CompaniesPage, discoveredQuery } from '@/components/CompaniesPage';
import { ResumeEditor } from '@/components/ResumeEditor';
import { ResumesPage } from '@/components/ResumesPage';
import { ReviewQueue } from '@/components/ReviewQueue';
import { StatsBar } from '@/components/StatsBar';
import { getJson, type JobsPage, type Pipeline, type Stats } from '@/lib/api';
import { apiParams, filtersFromSearch, filtersToSearch, type Filters } from '@/lib/filters';
import { cn } from '@/lib/utils';

const PAGE = 50;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type Tab = 'jobs' | 'review' | 'applications' | 'companies' | 'profile' | 'resume' | 'resumes';

export function App() {
  const [tab, setTab] = useState<Tab>(() => {
    if (window.location.pathname === '/review') return 'review';
    if (window.location.pathname === '/profile') return 'profile';
    if (window.location.pathname === '/resume') return 'resume';
    if (window.location.pathname === '/resumes') return 'resumes';
    if (window.location.pathname === '/applications') return 'applications';
    if (window.location.pathname === '/companies') return 'companies';
    return 'jobs';
  });
  const pipeline = useQuery({
    queryKey: ['pipeline'],
    queryFn: () => getJson<Pipeline>('/api/pipeline'),
    refetchInterval: 30_000,
  });
  const pendingCount = pipeline.data?.review.pending ?? 0;
  const discovered = useQuery(discoveredQuery(7));
  const [filters, setFilters] = useState<Filters>(() => filtersFromSearch(window.location.search));
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('job'),
  );
  const debounced = useDebounced(filters, 250);

  useEffect(() => {
    const path =
      tab === 'review'
        ? '/review'
        : tab === 'profile'
          ? '/profile'
          : tab === 'resume'
            ? '/resume'
            : tab === 'applications' || tab === 'companies' || tab === 'resumes'
              ? `/${tab}`
              : `/${filtersToSearch(filters, selected)}`;
    window.history.replaceState(null, '', path);
  }, [filters, selected, tab]);

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => getJson<Stats>('/api/stats'),
    refetchInterval: 30_000,
  });
  const jobs = useInfiniteQuery({
    queryKey: ['jobs', debounced],
    queryFn: ({ pageParam }) =>
      getJson<JobsPage>(`/api/jobs?${apiParams(debounced, PAGE, pageParam)}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => jobs.data?.pages.flatMap((p) => p.rows) ?? [], [jobs.data]);
  const total = jobs.data?.pages[0]?.total ?? 0;

  return (
    <div className="mx-auto flex h-screen max-w-[1500px] flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold tracking-tight">JobForge</h1>
          <nav className="flex gap-1 text-sm">
            {(['jobs', 'review', 'applications', 'companies', 'profile', 'resume', 'resumes'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-current={tab === t}
                className={cn(
                  'rounded-md px-2.5 py-1 capitalize',
                  tab === t
                    ? 'bg-muted font-medium'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t}
                {t === 'review' && pendingCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-ok px-1.5 text-xs font-semibold text-black">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <StatsBar stats={stats.data} />
      </header>
      {discovered.data?.alert && (
        <div className="border-b border-border bg-amber-100 px-4 py-2 text-sm text-amber-900">
          Discovery added {discovered.data.lastDay} companies in the last 24h (alert threshold {discovered.data.alertThreshold}).
          A list source may have changed shape —{' '}
          <button className="underline" onClick={() => setTab('companies')}>
            review them
          </button>
          .
        </div>
      )}
      {tab === 'companies' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <CompaniesPage />
        </main>
      ) : tab === 'applications' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ApplicationsPage
            onOpenJob={(id) => {
              setSelected(id);
              setTab('jobs');
            }}
          />
        </main>
      ) : tab === 'resumes' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ResumesPage />
        </main>
      ) : tab === 'resume' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ResumeEditor />
        </main>
      ) : tab === 'profile' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ProfilePage />
        </main>
      ) : tab === 'review' ? (
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ReviewQueue />
        </main>
      ) : (
        <>
          <Notices stats={stats.data} view={filters.view} total={total} loading={jobs.isPending} />
          <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(380px,5fr)_7fr]">
            <section
              className={cn(
                'flex min-h-0 flex-col gap-3 overflow-y-auto p-4',
                selected && 'hidden lg:flex',
              )}
            >
              <FilterBar value={filters} onChange={setFilters} />
              {jobs.error ? (
                <p className="text-sm text-red-600">
                  Could not load jobs: {jobs.error.message}. Is the server running?
                </p>
              ) : (
                <JobList
                  rows={rows}
                  total={total}
                  selected={selected}
                  onSelect={setSelected}
                  hasMore={!!jobs.hasNextPage}
                  loadingMore={jobs.isFetchingNextPage}
                  onLoadMore={() => void jobs.fetchNextPage()}
                />
              )}
            </section>
            <section
              className={cn(
                'min-h-0 overflow-y-auto border-border lg:border-l',
                !selected && 'hidden lg:block',
              )}
            >
              {selected ? (
                <JobDetail
                  key={selected}
                  id={selected}
                  onClose={() => setSelected(null)}
                  onOpenReview={() => setTab('review')}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
                  Select a job to see why it scored the way it did.
                </div>
              )}
            </section>
          </main>
        </>
      )}
    </div>
  );
}

function Notices({
  stats,
  view,
  total,
  loading,
}: {
  stats: Stats | undefined;
  view: Filters['view'];
  total: number;
  loading: boolean;
}) {
  if (!stats || loading) return null;
  let msg: string | null = null;
  if (!stats.profile)
    msg =
      'No profile loaded yet. Fill in profile/facts.yaml and preferences.yaml, then run `pnpm jf profile load`.';
  else if (stats.match.openJobs === 0)
    msg = 'No jobs yet. Import companies and run `pnpm jf fetch`.';
  else if (view === 'ranked' && stats.match.scored.llm === 0)
    msg = 'Nothing scored yet. Run `pnpm jf match`, or switch to All.';
  else if (view === 'ranked' && total === 0) msg = 'No ranked jobs match these filters.';
  if (!msg) return null;
  return <div className="border-b border-border bg-muted px-4 py-2 text-sm">{msg}</div>;
}
