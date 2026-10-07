import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getJson, send, PIPELINE_STATES, type ApplicationRow, type ApplicationsPage as Page, type PipelineState, type TimelineEntry } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const TONE: Record<PipelineState, string> = {
  candidate: 'bg-muted',
  referral_pending: 'bg-sky-100 text-sky-900',
  ready_to_apply: 'bg-amber-100 text-amber-900',
  applied: 'bg-emerald-100 text-emerald-900',
  expired: 'bg-muted text-muted-foreground',
  failed: 'bg-red-100 text-red-900',
};

/** Phase 12 audit page: every job the sequencer took on, its state, and its full timeline. */
export function ApplicationsPage({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const qc = useQueryClient();
  const [states, setStates] = useState<PipelineState[]>([]);
  const [company, setCompany] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['applications', states, company],
    queryFn: () => getJson<Page>(`/api/applications?${new URLSearchParams({ ...(states.length ? { state: states.join(',') } : {}), ...(company ? { company } : {}), limit: '200' })}`),
    refetchInterval: 30_000,
  });
  const run = useMutation({
    mutationFn: () => send<{ admitted: number; steps: unknown[] }>('/api/autopilot/sequence', 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['applications'] }),
  });
  const toggle = (s: PipelineState) => setStates((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {PIPELINE_STATES.map((s) => (
          <button key={s} onClick={() => toggle(s)} className={cn('rounded-md border px-2 py-1 text-xs', states.includes(s) ? 'border-foreground font-medium' : 'border-border text-muted-foreground')}>
            {s.replace(/_/g, ' ')} <span className="font-semibold">{q.data?.counts[s] ?? 0}</span>
          </button>
        ))}
        <Input className="w-48" placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} />
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? 'Running…' : 'Run sequencer now'}
        </Button>
      </div>
      {run.data && <p className="text-xs text-muted-foreground">{run.data.admitted} admitted · {run.data.steps.length} steps</p>}
      {run.error && <p className="text-xs text-red-600">{run.error.message}</p>}
      {q.error && <p className="text-sm text-red-600">Could not load: {q.error.message}</p>}
      {q.data && q.data.rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing in the pipeline yet. The autopilot (strategy: referrals) admits top matches each hour, or run it now.</p>}
      <div className="flex flex-col gap-2">
        {q.data?.rows.map((r) => (
          <Row key={r.jobId} r={r} expanded={open === r.jobId} onToggle={() => setOpen(open === r.jobId ? null : r.jobId)} onOpenJob={onOpenJob} />
        ))}
      </div>
    </div>
  );
}

function Row({ r, expanded, onToggle, onOpenJob }: { r: ApplicationRow; expanded: boolean; onToggle: () => void; onOpenJob: (id: string) => void }) {
  const qc = useQueryClient();
  const tl = useQuery({ queryKey: ['timeline', r.jobId], queryFn: () => getJson<{ timeline: TimelineEntry[] }>(`/api/applications/${r.jobId}/timeline`), enabled: expanded });
  const advance = useMutation({ mutationFn: () => send(`/api/jobs/${r.jobId}/advance`, 'POST', {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['applications'] }) });
  const expire = useMutation({ mutationFn: (reason: string) => send(`/api/jobs/${r.jobId}/expire`, 'POST', { reason }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['applications'] }) });
  const terminal = r.state === 'applied' || r.state === 'expired' || r.state === 'failed';
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge className={TONE[r.state]}>{r.state.replace(/_/g, ' ')}</Badge>
        <button className="font-medium hover:underline" onClick={() => onOpenJob(r.jobId)}>
          {r.title}
        </button>
        <span className="text-muted-foreground">{r.company}</span>
        <span className="text-xs text-muted-foreground">· {relativeDate(r.enteredStateAt)}</span>
        {r.metadata.reason && <span className="text-xs text-muted-foreground">· {String(r.metadata.reason).replace(/_/g, ' ')}</span>}
        {r.batch && (
          <span className="text-xs">
            · asks {r.batch.sent}/{r.batch.requested} sent, {r.batch.replied} replied
          </span>
        )}
        {r.inferredDeadline && <span className="text-xs text-amber-700">· ⏳ {r.inferredDeadline}</span>}
        {r.applicationStatus && <Badge variant="outline">application {r.applicationStatus}</Badge>}
        {r.metadata.manualApply && <Badge variant="outline">apply by hand</Badge>}
        <div className="ml-auto flex gap-1">
          {!terminal && (
            <Button size="sm" variant="ghost" onClick={() => advance.mutate()} disabled={advance.isPending} title={r.state === 'ready_to_apply' ? 'Mark as applied (by hand)' : 'Move to the next step'}>
              {r.state === 'ready_to_apply' ? 'Mark applied' : 'Advance'}
            </Button>
          )}
          {!terminal && (
            <Button size="sm" variant="ghost" onClick={() => { const reason = window.prompt('Why give up on this job?'); if (reason) expire.mutate(reason); }}>
              Expire
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onToggle}>
            {expanded ? 'Hide' : 'Timeline'}
          </Button>
        </div>
      </div>
      {r.metadata.applyError && !r.metadata.manualApply && <p className="mt-1 text-xs text-amber-700">{r.metadata.applyError}</p>}
      {(advance.error ?? expire.error) && <p className="mt-1 text-xs text-red-600">{(advance.error ?? expire.error)!.message}</p>}
      {expanded && (
        <ol className="mt-2 border-l border-border pl-3 text-xs">
          {tl.data?.timeline.map((e, i) => (
            <li key={i} className="py-0.5">
              <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span> · {e.summary}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
