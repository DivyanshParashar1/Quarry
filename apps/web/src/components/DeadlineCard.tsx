import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { send, type JobDetail } from '@/lib/api';
import { relativeDate } from '@/lib/format';

function daysUntil(date: string): number {
  return Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86_400_000);
}

/** Phase 10: inferred deadline with confidence and an expandable, sourced rationale. */
export function DeadlineCard({ job }: { job: JobDetail }) {
  const qc = useQueryClient();
  const infer = useMutation({
    mutationFn: () => send(`/api/jobs/${job.id}/deadline`, 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['job', job.id] }),
  });
  const d = job.deadline;
  const days = d?.date ? daysUntil(d.date) : null;
  const tone = days === null ? '' : days < 0 ? 'bg-muted text-muted-foreground' : days <= 3 ? 'bg-red-100 text-red-900' : days <= 10 ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900';
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarClock className="size-4" /> Application deadline
        </h3>
        {d?.date && (
          <>
            <Badge className={tone}>
              {d.date} · {days! < 0 ? `${-days!}d ago` : days === 0 ? 'today' : `in ${days}d`}
            </Badge>
            <Badge variant="outline" title="How sure the estimate is">
              {Math.round((d.confidence ?? 0) * 100)}% confident
            </Badge>
          </>
        )}
        {d && !d.date && <span className="text-sm text-muted-foreground">No estimate possible.</span>}
        {job.closedReason === 'deadline' && <Badge>closed: deadline passed</Badge>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => infer.mutate()} disabled={infer.isPending}>
          {infer.isPending ? 'Searching…' : d ? 'Re-estimate' : 'Estimate'}
        </Button>
      </div>
      {!d && <p className="mt-1 text-sm text-muted-foreground">Not estimated yet. Uses one LLM call with web search.</p>}
      {d?.rationale && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-muted-foreground">Why{d.inferredAt ? ` · estimated ${relativeDate(d.inferredAt)}` : ''}</summary>
          <p className="mt-1">{d.rationale}</p>
          {d.sources.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {d.sources.map((u) => (
                <li key={u}>
                  <a className="break-all underline" href={u} target="_blank" rel="noreferrer noopener">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {infer.error && <p className="mt-1 text-xs text-red-600">{infer.error.message}</p>}
    </Card>
  );
}
