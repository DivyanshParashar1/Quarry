import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Check, Play, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getJson, send } from '@/lib/api';
import { relativeDate } from '@/lib/format';

// Phase 22: the Health tab — what the orchestrator saw and did.

interface IncidentLogEntry {
  at: string;
  kind: string;
  [k: string]: unknown;
}

interface Incident {
  id: string;
  checkId: string;
  status: 'open' | 'acting' | 'verifying' | 'resolved' | 'escalated';
  severity: string;
  summary: string;
  expert: string | null;
  diagnosis: string | null;
  log: IncidentLogEntry[];
  attempts: number;
  llmCostUsd: number;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  verifyUntil: string | null;
}

interface OrchestratorStatus {
  llm: { todayUsd: number; calls: number; budgetUsd: number | null; pausedUntil: string | null };
  incidents: { active?: number; verifying?: number; escalated?: number; resolved7d?: number };
  codeFixes7d: { merged: number; reverted: number };
  pausedPlugins: Record<string, { until: string | null; reason: string; at: string }>;
  tenantOverrides: Record<string, Record<string, unknown>>;
}

const STATUS_TONE: Record<Incident['status'], string> = {
  open: 'bg-amber-100 text-amber-900',
  acting: 'bg-sky-100 text-sky-900',
  verifying: 'bg-violet-100 text-violet-900',
  escalated: 'bg-red-100 text-red-900',
  resolved: 'bg-emerald-100 text-emerald-900',
};

export function HealthPage() {
  const qc = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);
  const status = useQuery({ queryKey: ['orchestrator'], queryFn: () => getJson<OrchestratorStatus>('/api/orchestrator'), refetchInterval: 30_000 });
  const incidents = useQuery({
    queryKey: ['incidents', showResolved],
    queryFn: () => getJson<{ incidents: Incident[] }>(`/api/incidents?${showResolved ? '' : 'status=open,acting,verifying,escalated'}`),
    refetchInterval: 30_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['orchestrator'] });
    void qc.invalidateQueries({ queryKey: ['incidents'] });
  };
  const run = useMutation({ mutationFn: () => send('/api/orchestrator/run', 'POST'), onSettled: refresh });
  const resolve = useMutation({ mutationFn: (id: string) => send(`/api/incidents/${id}/resolve`, 'POST'), onSettled: refresh });
  const resume = useMutation({ mutationFn: (id: string) => send(`/api/ops/plugins/${encodeURIComponent(id)}/resume`, 'POST'), onSettled: refresh });
  const resumeLlm = useMutation({ mutationFn: () => send('/api/ops/llm/resume', 'POST'), onSettled: refresh });
  const s = status.data;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Activity className="size-5" /> Health
        </h2>
        <Button onClick={() => run.mutate()} disabled={run.isPending}>
          <Play className="size-4" /> {run.isPending ? 'Checking…' : 'Run checks now'}
        </Button>
      </div>
      {run.error && <p className="text-sm text-red-600">{run.error.message}</p>}

      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">LLM spend today</div>
            <div className="text-lg font-semibold">
              ${s.llm.todayUsd.toFixed(2)}
              {s.llm.budgetUsd !== null && <span className="text-sm font-normal text-muted-foreground"> / ${s.llm.budgetUsd}</span>}
            </div>
            <div className="text-xs text-muted-foreground">{s.llm.calls} calls</div>
            {s.llm.pausedUntil && (
              <div className="mt-1 text-xs text-red-700">
                paused until {new Date(s.llm.pausedUntil).toLocaleString()}{' '}
                <button className="underline" onClick={() => resumeLlm.mutate()}>
                  resume
                </button>
              </div>
            )}
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Open incidents</div>
            <div className="text-lg font-semibold">{(s.incidents.active ?? 0) + (s.incidents.verifying ?? 0)}</div>
            <div className="text-xs text-muted-foreground">{s.incidents.verifying ?? 0} verifying a fix</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Need you</div>
            <div className={`text-lg font-semibold ${s.incidents.escalated ? 'text-red-700' : ''}`}>{s.incidents.escalated ?? 0}</div>
            <div className="text-xs text-muted-foreground">{s.incidents.resolved7d ?? 0} resolved in 7 days</div>
          </Card>
          <Card className="p-3">
            <div className="text-xs text-muted-foreground">Code fixes (7 days)</div>
            <div className="text-lg font-semibold">{s.codeFixes7d.merged} merged</div>
            <div className="text-xs text-muted-foreground">{s.codeFixes7d.reverted} reverted</div>
          </Card>
        </div>
      )}

      {s && Object.keys(s.pausedPlugins).length > 0 && (
        <Card className="p-3 text-sm">
          <div className="mb-1 font-medium">Paused plugins</div>
          {Object.entries(s.pausedPlugins).map(([id, p]) => (
            <div key={id} className="flex items-center justify-between gap-2 py-1">
              <span>
                <code>{id}</code> — {p.reason} {p.until ? `(until ${new Date(p.until).toLocaleString()})` : ''}
              </span>
              <Button variant="outline" size="sm" onClick={() => resume.mutate(id)}>
                <RotateCcw className="size-3" /> Resume
              </Button>
            </div>
          ))}
        </Card>
      )}

      <div className="flex items-center justify-between">
        <h3 className="font-medium">Incidents</h3>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> include resolved
        </label>
      </div>
      {incidents.data?.incidents.length === 0 && <p className="text-sm text-muted-foreground">All checks pass.</p>}
      {incidents.data?.incidents.map((inc) => (
        <Card key={inc.id} className="flex flex-col gap-2 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_TONE[inc.status]}`}>{inc.status}</span>
            <Badge variant="outline">{inc.checkId}</Badge>
            {inc.expert && <Badge variant="outline">{inc.expert} expert</Badge>}
            <span className="ml-auto text-xs text-muted-foreground">opened {relativeDate(inc.openedAt)}</span>
          </div>
          <p className="text-sm font-medium">{inc.summary}</p>
          {inc.diagnosis && <p className="text-sm text-muted-foreground">{inc.diagnosis}</p>}
          {inc.verifyUntil && inc.status === 'verifying' && <p className="text-xs text-violet-800">watching the fix until {new Date(inc.verifyUntil).toLocaleString()}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">log ({inc.log.length})</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {inc.log.map((e, i) => (
                <li key={i} className="rounded bg-muted px-2 py-1">
                  <span className="font-medium">{e.kind}</span> <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                  <pre className="whitespace-pre-wrap break-all">{JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'at' && k !== 'kind')), null, 1)}</pre>
                </li>
              ))}
            </ul>
          </details>
          {inc.status !== 'resolved' && (
            <div>
              <Button variant="outline" size="sm" onClick={() => resolve.mutate(inc.id)} disabled={resolve.isPending}>
                <Check className="size-3" /> Mark resolved
              </Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
