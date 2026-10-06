import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Undo2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, send, type ReviewItem } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-ok text-black',
  approved: 'bg-good text-white',
  executed: 'bg-muted',
  rejected: 'bg-muted text-muted-foreground',
  failed: 'bg-red-600 text-white',
  cancelled: 'bg-muted text-muted-foreground',
};

export function ReviewCard({ item }: { item: ReviewItem }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(item.draft.subject);
  const [body, setBody] = useState(item.draft.body);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const dirty = subject !== item.draft.subject || body !== item.draft.body;
  const pending = item.status === 'pending';
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['review'] });
    void qc.invalidateQueries({ queryKey: ['job-outreach'] });
    void qc.invalidateQueries({ queryKey: ['pipeline'] });
  };
  const onError = (e: Error) => setError({ code: e instanceof ApiError ? e.code : 'error', message: e.message });

  const save = useMutation({
    mutationFn: () => send<ReviewItem>(`/api/review/${item.id}`, 'PATCH', { subject, body }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const approve = useMutation({
    mutationFn: (overrideCompanyCap: boolean) => send<ReviewItem>(`/api/review/${item.id}/approve`, 'POST', { overrideCompanyCap }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });
  const reject = useMutation({
    mutationFn: (reason: string | null) => send<ReviewItem>(`/api/review/${item.id}/reject`, 'POST', reason ? { reason } : {}),
    onSuccess: refresh,
    onError,
  });

  const doApprove = (override: boolean) => {
    const msg = `Approve this email to ${item.draft.toName} <${item.draft.to}>?\n\nIt will be sent from your Gmail by the send loop (only in live mode), at most once, within the daily cap.${override ? '\n\nThis overrides the per-company weekly limit.' : ''}`;
    if (window.confirm(msg)) approve.mutate(override);
  };
  const busy = save.isPending || approve.isPending || reject.isPending;
  const conf = item.contactEmailConfidence;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn('rounded px-1.5 py-0.5 text-xs font-medium capitalize', STATUS_TONE[item.status])}>{item.status}</span>
        <Badge variant="outline">{item.kind === 'followup' ? 'Follow-up' : 'First email'}</Badge>
        <span>
          To <span className="font-medium">{item.draft.toName}</span> &lt;{item.draft.to}&gt;
        </span>
        {conf !== null && conf < 1 && (
          <Badge variant="outline" className={conf < 0.5 ? 'border-red-400 text-red-600' : ''} title="Confidence that this address is right">
            email {Math.round(conf * 100)}% sure
          </Badge>
        )}
        <span className="text-muted-foreground">
          {item.companyName}
          {item.jobTitle ? ` · ${item.jobTitle}` : ''} · drafted {relativeDate(item.createdAt)}
          {item.editedAt ? ' · edited' : ''}
        </span>
      </div>

      {pending ? (
        <>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" className="font-medium" />
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(16, body.split('\n').length + 2)} aria-label="Body" />
        </>
      ) : (
        <div className="rounded-md border border-border bg-muted p-3 text-sm">
          <div className="font-medium">{item.draft.subject}</div>
          <pre className="mt-2 font-sans whitespace-pre-wrap">{item.draft.body}</pre>
        </div>
      )}

      {item.draft.factIds.length > 0 && <div className="text-xs text-muted-foreground">Grounded in facts: {item.draft.factIds.join(', ')}</div>}
      {item.error && <div className="text-xs text-amber-700 dark:text-amber-400">{item.error}</div>}
      {error && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-600">
          {error.message}
          {error.code === 'company_cap' && (
            <Button size="sm" variant="outline" onClick={() => doApprove(true)} disabled={busy}>
              Approve anyway
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {pending && (
          <>
            <Button onClick={() => doApprove(false)} disabled={busy || dirty} title={dirty ? 'Save your edits first' : undefined}>
              <Check className="h-4 w-4" /> Approve
            </Button>
            <Button variant="outline" onClick={() => save.mutate()} disabled={busy || !dirty || !subject.trim() || !body.trim()}>
              <Pencil className="h-4 w-4" /> Save edits
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSubject(item.draft.subject);
                  setBody(item.draft.body);
                }}
              >
                <Undo2 className="h-4 w-4" /> Discard
              </Button>
            )}
          </>
        )}
        {(pending || item.status === 'approved') && (
          <Button
            variant="ghost"
            onClick={() => {
              const reason = window.prompt(item.status === 'approved' ? 'Cancel this approved email? Optional reason:' : 'Reject this draft? Optional reason:');
              if (reason !== null) reject.mutate(reason.trim() || null);
            }}
            disabled={busy}
          >
            <X className="h-4 w-4" /> {item.status === 'approved' ? 'Cancel send' : 'Reject'}
          </Button>
        )}
        {item.status === 'approved' && <span className="self-center text-xs text-muted-foreground">Queued; sent by the send loop in live mode.</span>}
      </div>
    </Card>
  );
}
