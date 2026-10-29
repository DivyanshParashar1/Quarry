import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getJson, send, type SentEmail, type SentEmailsPage, type SentEmailStatus } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Phase 24: every email Quarry sent — compose, outreach, referral asks,
 * follow-ups — with what went out and, for compose mails, everything you put in.
 */

const STATUSES: SentEmailStatus[] = ['sent', 'scheduled', 'dry_run', 'failed', 'cancelled', 'queued'];
const STATUS_LABEL: Record<SentEmailStatus, string> = {
  sent: 'Sent',
  scheduled: 'Scheduled',
  dry_run: 'Dry run',
  failed: 'Failed',
  cancelled: 'Cancelled',
  queued: 'Queued',
};
const SOURCE_LABEL: Record<string, string> = { compose: 'Compose', outreach: 'Outreach', referral_ask: 'Referral ask', followup: 'Follow-up' };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

export function SentPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SentEmailStatus | null>(null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({ limit: '200', ...(status ? { status } : {}), ...(debounced ? { q: debounced } : {}) });
  const list = useQuery({ queryKey: ['sent-emails', status, debounced], queryFn: () => getJson<SentEmailsPage>(`/api/sent-emails?${params}`) });

  // Scheduled mails may have gone out while Quarry was off: check Gmail when the page opens.
  const reconcile = useMutation({
    mutationFn: () => send('/api/sent-emails/reconcile', 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sent-emails'] }),
  });
  const scheduledCount = list.data?.counts.scheduled ?? 0;
  useEffect(() => {
    if (scheduledCount > 0 && reconcile.isIdle) reconcile.mutate();
  }, [scheduledCount, reconcile]);

  const items = list.data?.items ?? [];
  const open = items.find((i) => i.id === openId) ?? null;
  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className={cn('flex min-w-0 flex-col gap-3', open && 'hidden lg:flex')}>
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="mr-2 text-sm font-semibold">Sent mail</h2>
          <FilterChip on={status === null} onClick={() => setStatus(null)}>
            All
          </FilterChip>
          {STATUSES.map((s) => (
            <FilterChip key={s} on={status === s} onClick={() => setStatus(s)}>
              {STATUS_LABEL[s]} {list.data ? <span className="text-muted-foreground">{list.data.counts[s]}</span> : null}
            </FilterChip>
          ))}
        </div>
        <Input placeholder="Search recipient, subject or body" value={q} onChange={(e) => setQ(e.target.value)} />
        {list.error && <p className="text-sm text-red-600">Could not load: {(list.error as Error).message}</p>}
        {list.data && items.length === 0 && <p className="text-sm text-muted-foreground">Nothing here yet. Mails you send from Compose (and outreach) show up here.</p>}
        <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-card">
          {items.map((m) => (
            <button key={m.id} onClick={() => setOpenId(m.id)} className={cn('flex flex-col gap-0.5 px-3 py-2 text-left hover:bg-muted', m.id === openId && 'bg-muted')}>
              <div className="flex items-center gap-2 text-sm">
                <span className="truncate font-medium">{m.toName || m.contactName || m.toAddress}</span>
                {m.companyName && <span className="truncate text-xs text-muted-foreground">{m.companyName}</span>}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmt(m.sentAt ?? m.scheduledFor ?? m.createdAt)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm">{m.subject}</span>
                {m.attachments.length > 0 && <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />}
                <span className="ml-auto flex shrink-0 gap-1">
                  <Badge variant="outline">{SOURCE_LABEL[m.source] ?? m.source}</Badge>
                  <StatusBadge m={m} />
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>
      <section className={cn('min-w-0', !open && 'hidden lg:block')}>
        {open ? (
          <SentDetail m={open} onClose={() => setOpenId(null)} />
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Select a mail to see everything about it.</div>
        )}
      </section>
    </div>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('rounded-md border px-2 py-0.5 text-xs', on ? 'border-primary bg-muted font-medium' : 'border-border text-muted-foreground hover:text-foreground')}>
      {children}
    </button>
  );
}

function StatusBadge({ m }: { m: SentEmail }) {
  if (m.status === 'sent' && m.threadState === 'replied') return <Badge className="bg-good/20">Replied</Badge>;
  if (m.status === 'sent' && m.threadState === 'bounced') return <Badge className="bg-red-100 text-red-800">Bounced</Badge>;
  const cls: Record<SentEmailStatus, string> = {
    sent: 'bg-muted',
    scheduled: 'bg-accent',
    dry_run: 'bg-ok/20',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-muted text-muted-foreground',
    queued: 'bg-muted text-muted-foreground',
  };
  return <Badge className={cls[m.status]}>{STATUS_LABEL[m.status]}</Badge>;
}

function SentDetail({ m, onClose }: { m: SentEmail; onClose: () => void }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => send(`/api/sent-emails/${m.id}/cancel`, 'POST', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sent-emails'] }),
  });
  const input = m.input ?? {};
  const isCompose = m.source === 'compose';
  return (
    <Card className="flex flex-col gap-3 p-4 text-sm">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold">{m.subject}</div>
          <div className="text-xs text-muted-foreground">
            To {m.toName ? `${m.toName} <${m.toAddress}>` : m.toAddress}
            {m.companyName ? ` · ${m.companyName}` : ''}
            {m.fromAddress ? ` · from ${m.fromAddress}` : ''}
          </div>
        </div>
        <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Status</dt>
        <dd className="flex items-center gap-1.5">
          <StatusBadge m={m} />
          {m.repliedAt && <span>replied {fmt(m.repliedAt)}</span>}
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd>{SOURCE_LABEL[m.source] ?? m.source}</dd>
        {m.sentAt && (
          <>
            <dt className="text-muted-foreground">Sent</dt>
            <dd>{fmt(m.sentAt)}</dd>
          </>
        )}
        {m.scheduledFor && (
          <>
            <dt className="text-muted-foreground">Scheduled for</dt>
            <dd>{fmt(m.scheduledFor)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Logged</dt>
        <dd>{fmt(m.createdAt)}</dd>
        {m.error && (
          <>
            <dt className="text-muted-foreground">Error</dt>
            <dd className="text-red-600">{m.error}</dd>
          </>
        )}
        {(m.gmailId || m.gmailThreadId) && (
          <>
            <dt className="text-muted-foreground">Gmail</dt>
            <dd className="font-mono text-[11px]">
              {m.gmailThreadId && (
                <a className="underline" href={`https://mail.google.com/mail/u/0/#all/${m.gmailThreadId}`} target="_blank" rel="noreferrer">
                  open thread
                </a>
              )}{' '}
              msg {m.gmailId ?? '—'} {m.gmailDraftId ? `· draft ${m.gmailDraftId}` : ''}
            </dd>
          </>
        )}
        {m.batchKey && typeof input.recipientsInBatch === 'number' && input.recipientsInBatch > 1 && (
          <>
            <dt className="text-muted-foreground">Batch</dt>
            <dd>one of {input.recipientsInBatch} recipients</dd>
          </>
        )}
      </dl>

      {m.status === 'scheduled' && (
        <div>
          <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            Cancel scheduled send
          </Button>
          {cancel.error && <span className="ml-2 text-xs text-red-600">{(cancel.error as Error).message}</span>}
        </div>
      )}

      <Section title="What went out">
        <pre className="whitespace-pre-wrap font-[inherit]">{m.body}</pre>
        {m.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.attachments.map((a, i) => (
              <a key={i} href={`/api/sent-emails/${m.id}/attachments/${i}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                <Paperclip className="h-3 w-3" /> {a.filename}
                {a.size ? <span className="text-muted-foreground">{Math.ceil(a.size / 1024)} KB</span> : null}
              </a>
            ))}
          </div>
        )}
      </Section>

      {isCompose && (
        <>
          <Section title="What you gave">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
              {input.form && (
                <>
                  <dt className="text-muted-foreground">Purpose</dt>
                  <dd>
                    {input.form.purpose} · {input.form.tone} · {input.form.length}
                  </dd>
                  <dt className="text-muted-foreground">About the mail</dt>
                  <dd className="whitespace-pre-wrap">{input.form.about || '—'}</dd>
                  <dt className="text-muted-foreground">Projects</dt>
                  <dd>{input.form.projectIds.length ? input.form.projectIds.join(', ') : '—'}{input.form.projectNotes ? ` — ${input.form.projectNotes}` : ''}</dd>
                </>
              )}
              {input.recipient && (
                <>
                  <dt className="text-muted-foreground">About the receiver</dt>
                  <dd className="whitespace-pre-wrap">{input.recipient.receiverInfo || '—'}</dd>
                  <dt className="text-muted-foreground">Your notes</dt>
                  <dd className="whitespace-pre-wrap">{input.recipient.notes || '—'}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Edited after picking</dt>
              <dd>{input.editedAfterPick == null ? 'written by hand' : input.editedAfterPick ? 'yes' : 'no'}</dd>
            </dl>
          </Section>
          {input.variants && input.variants.length > 0 && (
            <Section title="The drafts you saw">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {input.variants.map((v, i) => (
                  <div key={i} className={cn('rounded-md border border-border p-2 text-xs', input.chosenVariant === i && 'ring-2 ring-primary')}>
                    <div className="mb-1 flex items-center justify-between">
                      <Badge variant="outline">{v.angle}</Badge>
                      {input.chosenVariant === i && <span className="font-medium">picked</span>}
                    </div>
                    <div className="font-medium">{v.subject}</div>
                    <pre className="mt-1 whitespace-pre-wrap font-[inherit]">{v.body}</pre>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </>
      )}
      {!isCompose && (
        <Section title="How it was drafted">
          <pre className="whitespace-pre-wrap font-mono text-[11px]">{JSON.stringify(input, null, 2)}</pre>
          {m.original?.body && m.original.body !== m.body && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer">Draft before your edits</summary>
              <pre className="mt-1 whitespace-pre-wrap font-[inherit]">{m.original.body}</pre>
            </details>
          )}
        </Section>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      <div>{children}</div>
    </div>
  );
}
