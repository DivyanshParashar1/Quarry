import { useQuery } from '@tanstack/react-query';
import { ReviewItemCard } from '@/components/ReviewItemCard';
import { getJson, type ReviewItemAny } from '@/lib/api';

export function ReviewQueue() {
  const q = useQuery({
    queryKey: ['review', 'open'],
    queryFn: () => getJson<{ items: ReviewItemAny[] }>('/api/review?status=pending,approved,failed'),
    refetchInterval: 15_000,
  });
  const recent = useQuery({
    queryKey: ['review', 'recent'],
    queryFn: () => getJson<{ items: ReviewItemAny[] }>('/api/review?status=executed,rejected,cancelled&limit=20'),
  });
  if (q.error) return <p className="p-4 text-sm text-red-600">Could not load the review queue: {q.error.message}</p>;
  const items = q.data?.items ?? [];
  const pending = items.filter((i) => i.status === 'pending');
  const approved = items.filter((i) => i.status !== 'pending');
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Needs your decision ({pending.length})</h2>
        {pending.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing to review. Draft an email from a job's Outreach section, or run `pnpm jf outreach draft`.</p>
        )}
        {pending.map((i) => (
          <ReviewItemCard key={`${i.id}:${i.editedAt ?? ''}`} item={i} />
        ))}
      </section>
      {approved.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Approved, waiting to send ({approved.length})</h2>
          {approved.map((i) => (
            <ReviewItemCard key={i.id} item={i} />
          ))}
        </section>
      )}
      {(recent.data?.items.length ?? 0) > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">History</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {recent.data!.items
              .slice()
              .reverse()
              .map((i) => (
                <li key={i.id} className="flex gap-2 text-muted-foreground">
                  <span className="w-20 shrink-0 capitalize">{i.status}</span>
                  <span className="truncate">
                    {summary(i)}
                    {i.decisionNote ? ` · ${i.decisionNote}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function summary(i: ReviewItemAny): string {
  const d = i.draft as { toName?: string; subject?: string; note?: string; title?: string };
  if (d.title) return d.title;
  return `${d.toName ?? i.contactName ?? ''} · ${d.subject ?? d.note?.slice(0, 60) ?? i.kind}`;
}
