import { MapPin } from 'lucide-react';
import { ScoreBadge } from '@/components/ScoreBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { JobRow } from '@/lib/api';
import { cap, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  rows: JobRow[];
  total: number;
  selected: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

export function JobList({ rows, total, selected, onSelect, hasMore, loadingMore, onLoadMore }: Props) {
  return (
    <div className="flex flex-col">
      <div className="px-1 pb-2 text-xs text-muted-foreground">
        {total.toLocaleString()} job{total === 1 ? '' : 's'}
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              aria-current={selected === r.id}
              className={cn(
                'flex w-full gap-3 rounded-md border p-2.5 text-left transition-colors',
                selected === r.id ? 'border-primary bg-accent' : 'border-border bg-card hover:bg-muted',
              )}
            >
              <ScoreBadge score={r.score} method={r.method} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{r.title}</span>
                  {r.inferredDeadline && (r.deadlineConfidence ?? 0) >= 0.4 && (
                    <span className="shrink-0 text-xs text-amber-700" title="Inferred application deadline">
                      ⏳ {r.inferredDeadline.slice(5)}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeDate(r.postedAt ?? r.firstSeenAt)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.company}</span>
                  {r.locations.length > 0 && (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span className="truncate">{r.locations.slice(0, 2).join(' · ')}{r.locations.length > 2 ? ` +${r.locations.length - 2}` : ''}</span>
                    </span>
                  )}
                  {r.remotePolicy && <Badge variant="outline">{cap(r.remotePolicy)}</Badge>}
                  {r.seniority && <Badge variant="outline">{cap(r.seniority)}</Badge>}
                  {r.closedAt && <Badge>Closed</Badge>}
                </div>
                {r.reasons && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.reasons}</p>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button variant="outline" className="mt-3" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
