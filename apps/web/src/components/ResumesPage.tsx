import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Pin, RefreshCw, Trash2, X } from 'lucide-react';
import { scoreTone } from '@/components/AtsScoreCard';
import { fitLabel, STATUS_STYLE } from '@/components/ResumePanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  ATS_TYPES,
  getJson,
  send,
  type BenchmarkCategory,
  type BenchmarkJob,
  type JobsPage,
  type LibraryPage,
  type LibraryRun,
  type ResumeVariant,
} from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Phase 16: the resume library — every project combo (+ base resumes) rendered up
 * front, benchmarked against a few JDs per job category under every ATS profile.
 * Per-job tailoring then only rewrites the chosen combo's Technical Skills.
 */
export function ResumesPage() {
  const qc = useQueryClient();
  const [showRetired, setShowRetired] = useState(false);
  const lib = useQuery({
    queryKey: ['resume-library', showRetired],
    queryFn: () => getJson<LibraryPage>(`/api/resumes/library${showRetired ? '?includeRetired=1' : ''}`),
  });
  const runQ = useQuery({
    queryKey: ['resume-library-run'],
    queryFn: () => getJson<LibraryRun>('/api/resumes/library/run'),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const run = runQ.data ?? lib.data?.run;

  // Refresh the library when a run finishes.
  const finishedAt = run?.finishedAt;
  useEffect(() => {
    if (finishedAt) void qc.invalidateQueries({ queryKey: ['resume-library'] });
  }, [finishedAt, qc]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['resume-library'] });
    void qc.invalidateQueries({ queryKey: ['resume-library-run'] });
  };
  const generate = useMutation({
    mutationFn: (retire: boolean) => send<LibraryRun>('/api/resumes/library/generate', 'POST', { retire }),
    onSuccess: refresh,
  });
  const bench = useMutation({
    mutationFn: (pick: boolean) => send<unknown>(pick ? '/api/resumes/benchmarks/pick' : '/api/resumes/benchmarks/run', 'POST', {}),
    onSuccess: refresh,
  });

  const data = lib.data;
  const running = !!run?.running;
  const scrap = () => {
    if (
      window.confirm(
        'Scrap & regenerate: render every combo again (one LLM call each for the skills), then retire the current library resumes. Past applications keep their PDFs. Continue?',
      )
    )
      generate.mutate(true);
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Resume library</h2>
        {data && (
          <span className="text-xs text-muted-foreground">
            {data.resumes.filter((r) => !r.retiredAt).length} active · {data.benchmarkJobs.length} benchmark JDs
          </span>
        )}
        <label className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          show retired
        </label>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => generate.mutate(false)} disabled={running || generate.isPending}>
            Generate missing
          </Button>
          <Button size="sm" variant="outline" onClick={() => bench.mutate(false)} disabled={running || bench.isPending}>
            Re-run benchmarks
          </Button>
          <Button size="sm" onClick={scrap} disabled={running || generate.isPending}>
            <RefreshCw className={cn('h-3.5 w-3.5', running && 'animate-spin')} />
            Scrap &amp; regenerate
          </Button>
        </div>
      </div>
      {(generate.error || bench.error) && (
        <p className="text-sm text-red-600">{((generate.error ?? bench.error) as Error).message}</p>
      )}
      {run && (run.running || run.finishedAt) && <RunStatus run={run} />}
      {lib.error && <p className="text-sm text-red-600">Could not load the library: {(lib.error as Error).message}</p>}
      {data && !data.resumes.length && (
        <Card className="p-4 text-sm text-muted-foreground">
          The library is empty. "Generate missing" renders every combo of <code>resumes.projectsPerResume</code> projects
          (plus <code>profile/resume/base/*.yaml</code>), each with its Technical Skills tailored to its own projects, then
          benchmarks them. Until then, jobs fall back to a full per-job tailor.
        </Card>
      )}
      {data && data.resumes.length > 0 && <LibraryTable data={data} />}
      {data && <Benchmarks data={data} onChanged={refresh} picking={bench.isPending} onPick={() => bench.mutate(true)} />}
    </div>
  );
}

function RunStatus({ run }: { run: LibraryRun }) {
  return (
    <Card className="flex flex-col gap-1 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{run.running ? 'Running' : 'Last run'}{run.retire ? ' (scrap & regenerate)' : ''}</span>
        <span className="text-muted-foreground">
          {run.done}/{run.total || '?'} resumes
          {run.finishedAt && ` · finished ${relativeDate(run.finishedAt)}`}
          {run.retired > 0 && ` · retired ${run.retired}`}
          {run.benchmarks && ` · benchmarked ${run.benchmarks.resumes} × ${run.benchmarks.jobs} JDs`}
        </span>
      </div>
      {run.error && <p className="text-red-600">{run.error}</p>}
      {run.items.some((i) => i.status === 'failed' || (i.resumeStatus && i.resumeStatus !== 'rendered')) && (
        <ul className="text-red-600">
          {run.items
            .filter((i) => i.status === 'failed' || (i.resumeStatus && i.resumeStatus !== 'rendered'))
            .map((i) => (
              <li key={i.key}>
                {i.label}: {i.resumeStatus ?? i.status}
                {i.error && ` — ${i.error.split('\n')[0]}`}
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

function LibraryTable({ data }: { data: LibraryPage }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-xs">
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th className="p-2 text-left font-normal">Resume</th>
            <th className="p-2 text-left font-normal">Status</th>
            {data.categories.map((c) => (
              <th key={c.id} className="p-2 text-right font-normal" title="Mean ATS score over the category's benchmark JDs and every ATS profile">
                {c.label}
              </th>
            ))}
            <th className="p-2 text-right font-normal">PDF</th>
          </tr>
        </thead>
        <tbody>
          {data.resumes.map((r) => (
            <ResumeRow key={r.id} r={r} data={data} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ResumeRow({ r, data, open, onToggle }: { r: ResumeVariant; data: LibraryPage; open: boolean; onToggle: () => void }) {
  const cells = data.matrix[r.id] ?? {};
  return (
    <>
      <tr className={cn('cursor-pointer border-b border-border hover:bg-muted/50', r.retiredAt && 'opacity-50')} onClick={onToggle}>
        <td className="p-2">
          <div className="font-medium">{r.label ?? r.id.slice(0, 8)}</div>
          <div className="text-muted-foreground">
            {r.kind} · {relativeDate(r.createdAt)}
            {r.bullets.pages != null && ` · ${r.bullets.pages}pp`}
            {r.fit && fitLabel(r.fit)}
            {r.retiredAt && ` · retired ${relativeDate(r.retiredAt)}`}
          </div>
        </td>
        <td className="p-2">
          <Badge className={STATUS_STYLE[r.status]}>{r.status.replace('_', ' ')}</Badge>
        </td>
        {data.categories.map((c) => {
          const cell = cells[c.id];
          return (
            <td key={c.id} className="p-2 text-right">
              {cell ? <Badge className={scoreTone(cell.avg)}>{cell.avg}</Badge> : <span className="text-muted-foreground">–</span>}
            </td>
          );
        })}
        <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
          {r.pdfPath && (
            <a href={`/api/resume-variants/${r.id}/pdf`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
              <FileText className="h-3.5 w-3.5" />
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-muted/30">
          <td colSpan={data.categories.length + 3} className="p-3">
            <AtsBreakdown r={r} data={data} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Per-ATS averages by category, plus every benchmark JD's score under each ATS. */
function AtsBreakdown({ r, data }: { r: ResumeVariant; data: LibraryPage }) {
  const cells = data.matrix[r.id] ?? {};
  const rows = data.scores.filter((s) => s.variantId === r.id);
  const jobTitle = new Map(data.benchmarkJobs.map((j) => [j.jobId, j.title]));
  if (!rows.length) return <p className="text-xs text-muted-foreground">Not benchmarked yet — "Re-run benchmarks".</p>;
  return (
    <div className="flex flex-col gap-3 text-xs">
      <table className="w-full">
        <thead className="text-muted-foreground">
          <tr>
            <th className="text-left font-normal">Category</th>
            {ATS_TYPES.map((a) => (
              <th key={a} className="text-right font-normal">
                {a}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.categories.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              {ATS_TYPES.map((a) => {
                const v = cells[c.id]?.byAts[a];
                return (
                  <td key={a} className="text-right">
                    {v ?? '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="cursor-pointer text-muted-foreground">Per benchmark JD</summary>
        <table className="mt-1 w-full">
          <tbody>
            {rows.map((row) => (
              <tr key={row.jobId}>
                <td className="pr-2">{jobTitle.get(row.jobId) ?? row.jobId.slice(0, 8)}</td>
                {ATS_TYPES.map((a) => (
                  <td key={a} className="text-right">
                    {row.scores[a]?.score ?? '–'}
                  </td>
                ))}
                <td className="pl-2 text-red-600">{row.scores.generic?.hardMissing.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Benchmarks({ data, onChanged, onPick, picking }: { data: LibraryPage; onChanged: () => void; onPick: () => void; picking: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Benchmark JDs</h3>
        <span className="text-xs text-muted-foreground">
          Auto-picked by title keywords + match score; pin your own and they're never replaced.
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAdding(!adding)}>
            {adding ? 'Cancel' : 'Add category'}
          </Button>
          <Button size="sm" variant="outline" onClick={onPick} disabled={picking}>
            {picking ? 'Picking…' : 'Re-pick auto JDs'}
          </Button>
        </div>
      </div>
      {adding && (
        <CategoryForm
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {data.categories.map((c) => (
          <CategoryCard key={c.id} category={c} jobs={data.benchmarkJobs.filter((j) => j.categoryId === c.id)} onChanged={onChanged} />
        ))}
      </div>
    </Card>
  );
}

function CategoryForm({ onSaved }: { onSaved: () => void }) {
  const [label, setLabel] = useState('');
  const [keywords, setKeywords] = useState('');
  const [exclude, setExclude] = useState('senior, staff, principal, manager');
  const save = useMutation({
    mutationFn: () =>
      send('/api/resumes/categories', 'POST', {
        id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        label,
        titleKeywords: split(keywords),
        excludeKeywords: split(exclude),
      }),
    onSuccess: onSaved,
  });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
      <Input placeholder="Label, e.g. Data engineer" value={label} onChange={(e) => setLabel(e.target.value)} />
      <Input placeholder="Title keywords (comma-separated), e.g. data engineer, analytics engineer" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
      <Input placeholder="Exclude titles containing (comma-separated)" value={exclude} onChange={(e) => setExclude(e.target.value)} />
      {save.error && <p className="text-red-600">{(save.error as Error).message}</p>}
      <Button size="sm" onClick={() => save.mutate()} disabled={!label.trim() || !split(keywords).length || save.isPending}>
        Save category
      </Button>
    </div>
  );
}

function split(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function CategoryCard({ category: c, jobs, onChanged }: { category: BenchmarkCategory; jobs: BenchmarkJob[]; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['benchmark-search', q],
    queryFn: () => getJson<JobsPage>(`/api/jobs?q=${encodeURIComponent(q)}&limit=6`),
    enabled: q.trim().length >= 3,
  });
  const pin = useMutation({
    mutationFn: (jobId: string) => send('/api/resumes/benchmarks/jobs', 'POST', { categoryId: c.id, jobId }),
    onSuccess: () => {
      setQ('');
      onChanged();
    },
  });
  const unpin = useMutation({
    mutationFn: (jobId: string) => send(`/api/resumes/benchmarks/jobs/${c.id}/${jobId}`, 'DELETE'),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => send(`/api/resumes/categories/${c.id}`, 'DELETE'),
    onSuccess: onChanged,
  });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="shrink-0 whitespace-nowrap font-medium">{c.label}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={`titles: ${c.titleKeywords.join(', ')}; excluding: ${c.excludeKeywords.join(', ')}`}>
          {c.titleKeywords.join(', ')}
        </span>
        <button
          className="ml-auto text-muted-foreground hover:text-red-600"
          title="Delete category"
          onClick={() => window.confirm(`Delete the "${c.label}" category and its benchmark JDs?`) && remove.mutate()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-1">
        {jobs.map((j) => (
          <li key={j.jobId} className={cn('flex items-center gap-1', j.closedAt && 'opacity-50')}>
            {j.pinned && <Pin className="h-3 w-3" />}
            <span className="truncate">{j.title}</span>
            {j.closedAt && <span className="text-muted-foreground">(closed)</span>}
            <button className="ml-auto text-muted-foreground hover:text-red-600" title="Remove" onClick={() => unpin.mutate(j.jobId)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {!jobs.length && <li className="text-muted-foreground">No JDs yet — "Re-pick auto JDs" or pin one below.</li>}
      </ul>
      <Input placeholder="Pin a JD: search jobs…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-xs" />
      {search.data && q.trim().length >= 3 && (
        <ul className="flex flex-col gap-1">
          {search.data.rows.map((j) => (
            <li key={j.id} className="flex items-center gap-1">
              <span className="truncate">
                {j.title} <span className="text-muted-foreground">· {j.company}</span>
              </span>
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-1.5" onClick={() => pin.mutate(j.id)}>
                <Pin className="h-3 w-3" /> Pin
              </Button>
            </li>
          ))}
          {!search.data.rows.length && <li className="text-muted-foreground">No matches.</li>}
        </ul>
      )}
    </div>
  );
}
