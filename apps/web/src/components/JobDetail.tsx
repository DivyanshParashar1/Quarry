import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { ExternalLink, X } from 'lucide-react';
import { OutreachPanel } from '@/components/OutreachPanel';
import { ScoreBadge } from '@/components/ScoreBadge';
import { Badge } from '@/components/ui/badge';
import { buttonVariants, Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getJson, type JobDetail as Detail } from '@/lib/api';
import { cap, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const RUBRIC: [keyof NonNullable<Detail['match']>['rubric'], string][] = [
  ['stack_fit', 'Stack'],
  ['seniority_fit', 'Seniority'],
  ['location_fit', 'Location'],
  ['eligibility', 'Eligibility'],
];

export function JobDetail({ id, onClose, onOpenReview }: { id: string; onClose: () => void; onOpenReview: () => void }) {
  const { data: job, error, isPending } = useQuery({ queryKey: ['job', id], queryFn: () => getJson<Detail>(`/api/jobs/${id}`) });

  if (isPending) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (error || !job) return <div className="p-6 text-sm text-red-600">Could not load this job. {error?.message}</div>;
  const m = job.match;

  return (
    <article className="flex flex-col gap-4 p-5">
      <header className="flex items-start gap-3">
        <ScoreBadge score={m?.score ?? null} method={m?.method ?? null} className="h-12 w-12 text-lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight font-semibold">{job.title}</h2>
          <div className="mt-0.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{job.company.name}</span>
            {job.locations.length > 0 && <> · {job.locations.join(' · ')}</>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {job.remotePolicy && <Badge variant="outline">{cap(job.remotePolicy)}</Badge>}
            {job.seniority && <Badge variant="outline">{cap(job.seniority)}</Badge>}
            {job.postedAt && <Badge variant="outline">Posted {relativeDate(job.postedAt)}</Badge>}
            {job.closedAt && <Badge>Closed {relativeDate(job.closedAt)}</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {job.applyUrl && (
            <a href={job.applyUrl} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'sm' })}>
              Open posting <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <Card className="p-4">
        <h3 className="mb-2 text-sm font-semibold">Why this score</h3>
        {!m && <p className="text-sm text-muted-foreground">Not scored against the current profile yet. Run <code>jf match</code>.</p>}
        {m && (
          <>
            <p className="text-sm">{m.reasons}</p>
            {m.method === 'llm' && (
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                {RUBRIC.map(([k, label]) => {
                  const v = typeof m.rubric[k] === 'number' ? (m.rubric[k] as number) : null;
                  return (
                    <div key={k}>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{label}</span>
                        <span className="tabular-nums">{v ?? '–'}/10</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded-full bg-muted">
                        <div
                          className={cn('h-1.5 rounded-full', v === null ? '' : v >= 7 ? 'bg-good' : v >= 4 ? 'bg-ok' : 'bg-weak')}
                          style={{ width: `${(v ?? 0) * 10}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {m.rubric.concerns && m.rubric.concerns.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-muted-foreground">Concerns</div>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {m.rubric.concerns.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {m.similarity !== null && <span>similarity {m.similarity.toFixed(2)}</span>}
              {m.provider && (
                <span>
                  {m.provider}/{m.model}
                </span>
              )}
              <span>scored {relativeDate(m.createdAt)}</span>
            </div>
          </>
        )}
      </Card>

      <OutreachPanel jobId={job.id} onOpenReview={onOpenReview} />

      <section>
        <h3 className="mb-1 text-sm font-semibold">Description</h3>
        {job.descriptionMd ? (
          <div className="prose-job text-sm leading-relaxed">
            <Markdown>{job.descriptionMd}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </section>

      <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
        Seen on{' '}
        {job.sources.map((s, i) => (
          <span key={`${s.sourcePlugin}:${s.externalId}`}>
            {i > 0 && ', '}
            {s.url ? (
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="underline">
                {s.sourcePlugin}
              </a>
            ) : (
              s.sourcePlugin
            )}
          </span>
        ))}{' '}
        · first seen {relativeDate(job.firstSeenAt)} · last seen {relativeDate(job.lastSeenAt)}
      </footer>
    </article>
  );
}
