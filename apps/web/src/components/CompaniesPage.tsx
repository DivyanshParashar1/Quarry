import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getJson, send, type DiscoveredCompany, type DiscoveredPage } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export const discoveredQuery = (days: number) => ({
  queryKey: ['companies-discovered', days],
  queryFn: () => getJson<DiscoveredPage>(`/api/companies/discovered?days=${days}`),
  refetchInterval: 60_000,
});

/** Phase 13: companies discovery added recently, with a manual tag / exclude override. */
export function CompaniesPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const q = useQuery(discoveredQuery(days));
  const nightly = useMutation({
    mutationFn: () => send<{ started: string }>('/api/discovery/nightly', 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['companies-discovered'] }),
  });
  const recheck = useMutation({
    mutationFn: () => send<{ checked: number; newSources: number; staleSources: number }>('/api/discovery/recheck', 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['companies-discovered'] }),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {[1, 7, 30].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn('rounded-md border px-2 py-1 text-xs', days === d ? 'border-foreground font-medium' : 'border-border text-muted-foreground')}
          >
            last {d}d
          </button>
        ))}
        {q.data && (
          <span className="text-xs text-muted-foreground">
            {q.data.companies.length} discovered · {q.data.lastDay} in the last 24h{q.data.running ? ` · running: ${q.data.running}` : ''}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            {recheck.isPending ? 'Re-checking…' : 'Re-check ATSs'}
          </Button>
          <Button size="sm" variant="outline" onClick={() => nightly.mutate()} disabled={nightly.isPending || !!q.data?.running}>
            Run discovery now
          </Button>
        </div>
      </div>
      {recheck.data && (
        <p className="text-xs text-muted-foreground">
          Checked {recheck.data.checked} · {recheck.data.newSources} new boards · {recheck.data.staleSources} marked stale
        </p>
      )}
      {(nightly.error ?? recheck.error) && <p className="text-xs text-red-600">{(nightly.error ?? recheck.error)!.message}</p>}
      {q.error && <p className="text-sm text-red-600">Could not load: {q.error.message}</p>}
      {q.data && q.data.companies.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing discovered in this window. Enable <code>discovery.nightly</code> in config, or run `pnpm jf discover_companies --all`.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {q.data?.companies.map((c) => <CompanyRow key={c.id} c={c} />)}
      </div>
    </div>
  );
}

function CompanyRow({ c }: { c: DiscoveredCompany }) {
  const qc = useQueryClient();
  const [tag, setTag] = useState('');
  const tags = useMutation({
    mutationFn: (b: { add?: string[]; remove?: string[] }) => send<{ tags: string[] }>(`/api/companies/${c.id}/tags`, 'POST', b),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['companies-discovered'] }),
  });
  const excluded = c.tags.includes('excluded');
  return (
    <Card className={cn('flex flex-col gap-2 p-3', excluded && 'opacity-60')}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{c.name}</span>
        {c.domain && <span className="text-xs text-muted-foreground">{c.domain}</span>}
        <span className="text-xs text-muted-foreground">
          via {c.discoveredVia ?? '?'}{c.discoveredAt ? ` · ${relativeDate(c.discoveredAt)}` : ''}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={tags.isPending}
          onClick={() => tags.mutate(excluded ? { remove: ['excluded'] } : { add: ['excluded'] })}
        >
          {excluded ? 'Include' : 'Exclude'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {c.sources.length === 0 && <span className="text-xs text-muted-foreground">no board detected</span>}
        {c.sources.map((s) => (
          <Badge key={`${s.atsType}:${s.boardToken}`} variant="outline" className={cn(s.status !== 'active' && 'line-through')}>
            {s.atsType}
            {s.boardToken ? `:${s.boardToken}` : ''}
            {s.status !== 'active' ? ` (${s.status})` : ''}
          </Badge>
        ))}
        <span className="mx-1 h-4 border-l border-border" />
        {c.tags.map((t) => (
          <Badge key={t} className="gap-1">
            {t}
            <button aria-label={`remove tag ${t}`} className="text-muted-foreground hover:text-foreground" onClick={() => tags.mutate({ remove: [t] })}>
              ×
            </button>
          </Badge>
        ))}
        <form
          className="flex"
          onSubmit={(e) => {
            e.preventDefault();
            if (tag.trim()) tags.mutate({ add: [tag.trim()] });
            setTag('');
          }}
        >
          <Input className="h-6 w-28 text-xs" placeholder="add tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        </form>
      </div>
      {tags.error && <p className="text-xs text-red-600">{tags.error.message}</p>}
    </Card>
  );
}
