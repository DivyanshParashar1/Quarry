import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Mail, Network, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getJson, send, type FanOutResponse, type ReferralItem, type ReferralPanelData } from '@/lib/api';
import { relativeDate } from '@/lib/format';

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-900',
  approved: 'bg-sky-100 text-sky-900',
  executed: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
  failed: 'bg-red-100 text-red-900',
};

function itemLabel(i: ReferralItem): string {
  if (i.threadState === 'replied') return 'replied';
  if (i.status === 'executed') return i.channel === 'linkedin' ? 'request sent' : 'sent';
  return i.status;
}

/** Per-job referral fan-out (Phase 8): N asks to distinct people, one-click approve. */
export function ReferralPanel({ jobId, onOpenReview }: { jobId: string; onOpenReview: () => void }) {
  const qc = useQueryClient();
  const key = ['job-referrals', jobId];
  const q = useQuery({ queryKey: key, queryFn: () => getJson<ReferralPanelData>(`/api/jobs/${jobId}/referrals`) });
  const [count, setCount] = useState('10');
  const [msg, setMsg] = useState<string | null>(null);
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['review'] });
    void qc.invalidateQueries({ queryKey: ['job-outreach', jobId] });
  };

  const fanout = useMutation({
    mutationFn: () => send<FanOutResponse>(`/api/jobs/${jobId}/referrals/fanout`, 'POST', { count: Number(count) || 10 }),
    onSuccess: (r) => {
      const skipped = r.skipped.length ? ` ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].slice(0, 2).join('; ')}).` : '';
      setMsg(`${r.drafted.length} new ask(s) drafted${r.foundContacts ? `, ${r.foundContacts} people found on LinkedIn` : ''}.${r.shortBy ? ` Short by ${r.shortBy}: add contacts or enable LinkedIn.` : ''}${skipped}`);
      done();
    },
    onError: (e: Error) => setMsg(e.message),
  });
  const approveAll = useMutation({
    mutationFn: (ids?: string[]) => send<{ approved: string[]; failed: { error: string }[] }>(`/api/jobs/${jobId}/referrals/approve`, 'POST', ids ? { ids } : {}),
    onSuccess: (r) => {
      setMsg(`Approved ${r.approved.length}.${r.failed.length ? ` Refused ${r.failed.length}: ${r.failed[0]!.error}` : ''}`);
      done();
    },
    onError: (e: Error) => setMsg(e.message),
  });

  if (q.isPending) return null;
  if (q.error || !q.data) return <p className="text-sm text-red-600">Could not load referrals: {q.error?.message}</p>;
  const { batch, items } = q.data;
  const pending = items.filter((i) => i.status === 'pending');

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Users className="size-4" /> Referrals
        </h3>
        {batch && (
          <span className="text-xs text-muted-foreground">
            {batch.status.replace('_', ' ')} · {batch.draftedCount}/{batch.requestedCount} drafted · {batch.sentCount} sent · {batch.repliedCount} replied
            {batch.repliedAt ? ` · first reply ${relativeDate(batch.repliedAt)}` : ''}
          </span>
        )}
      </div>

      {!batch && <p className="mb-2 text-sm text-muted-foreground">Ask several people at this company to refer you. Nothing is sent until you approve.</p>}

      {items.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
              {i.channel === 'email' ? <Mail className="size-3.5 text-muted-foreground" /> : <Network className="size-3.5 text-muted-foreground" />}
              <span className="font-medium">{i.contactName}</span>
              {i.contactRole && <span className="max-w-[18rem] truncate text-muted-foreground">{i.contactRole}</span>}
              <Badge className={STATUS_TONE[i.threadState === 'replied' ? 'executed' : i.status] ?? ''}>{itemLabel(i)}</Badge>
              {i.decidedBy === 'autopilot' && <Badge variant="outline">autopilot</Badge>}
              {i.error && <span className="text-xs text-red-700">{i.error}</span>}
              {i.status === 'pending' && (
                <Button size="sm" variant="ghost" onClick={() => approveAll.mutate([i.id])} disabled={approveAll.isPending}>
                  Approve
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {batch?.status !== 'replied' && batch?.status !== 'closed' && (
          <>
            <Input className="w-16" type="number" min={1} max={50} value={count} onChange={(e) => setCount(e.target.value)} aria-label="asks" />
            <Button size="sm" variant="outline" onClick={() => fanout.mutate()} disabled={fanout.isPending}>
              {fanout.isPending ? 'Drafting…' : batch ? 'Top up asks' : 'Fan out referral asks'}
            </Button>
          </>
        )}
        {pending.length > 0 && (
          <Button
            size="sm"
            onClick={() => {
              if (window.confirm(`Approve ${pending.length} referral ask(s)? Emails and LinkedIn requests go out from your accounts once approved.`)) approveAll.mutate(undefined);
            }}
            disabled={approveAll.isPending}
          >
            <CheckCheck className="size-4" /> Approve all {pending.length}
          </Button>
        )}
        {pending.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onOpenReview}>
            Review drafts
          </Button>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
    </Card>
  );
}
