import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Network, Pencil, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ReviewCard } from '@/components/ReviewCard';
import { ApplicationCard } from '@/components/ApplicationCard';
import { send, isEmailDraft, isLinkedInDraft, type AttentionDraft, type LinkedInNoteDraft, type ReviewItem, type ReviewItemAny } from '@/lib/api';
import { relativeDate } from '@/lib/format';

/** Picks the right card for a review item's draft (email, LinkedIn note, attention, application). */
export function ReviewItemCard({ item }: { item: ReviewItemAny }) {
  if (item.kind === 'attention') return <AttentionCard item={item} />;
  if (item.kind === 'application') return <ApplicationCard item={item} />;
  if (isLinkedInDraft(item.draft)) return <LinkedInCard item={item} />;
  if (isEmailDraft(item.draft)) return <ReviewCard item={item as ReviewItem} />;
  return (
    <Card className="p-4 text-sm">
      <Badge variant="outline">{item.kind}</Badge> <pre className="mt-2 whitespace-pre-wrap">{JSON.stringify(item.draft, null, 2)}</pre>
    </Card>
  );
}

export function useReviewActions(id: string, onError: (e: Error) => void) {
  const qc = useQueryClient();
  const refresh = () => {
    for (const k of ['review', 'job-outreach', 'job-referrals', 'pipeline', 'applications']) void qc.invalidateQueries({ queryKey: [k] });
  };
  return {
    save: useMutation({ mutationFn: (patch: object) => send(`/api/review/${id}`, 'PATCH', patch), onSuccess: refresh, onError }),
    approve: useMutation({ mutationFn: () => send(`/api/review/${id}/approve`, 'POST', {}), onSuccess: refresh, onError }),
    reject: useMutation({ mutationFn: (reason: string | null) => send(`/api/review/${id}/reject`, 'POST', reason ? { reason } : {}), onSuccess: refresh, onError }),
  };
}

function LinkedInCard({ item }: { item: ReviewItemAny }) {
  const draft = item.draft as LinkedInNoteDraft;
  const [note, setNote] = useState(draft.note);
  const [error, setError] = useState<string | null>(null);
  const a = useReviewActions(item.id, (e) => setError(e.message));
  const pending = item.status === 'pending';
  const dirty = note !== draft.note;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge className="capitalize">{item.status}</Badge>
        <Badge variant="outline">
          <Network className="mr-1 size-3" /> LinkedIn referral ask
        </Badge>
        <a className="font-medium underline" href={draft.profileUrl} target="_blank" rel="noreferrer">
          {draft.toName}
        </a>
        <span className="text-muted-foreground">
          {item.companyName}
          {item.jobTitle ? ` · ${item.jobTitle}` : ''} · drafted {relativeDate(item.createdAt)}
        </span>
      </div>
      {pending ? (
        <>
          <Textarea value={note} maxLength={300} rows={4} onChange={(e) => setNote(e.target.value)} aria-label="Connection note" />
          <span className="text-xs text-muted-foreground">{note.length}/300 characters (LinkedIn's limit)</span>
        </>
      ) : (
        <div className="rounded-md border border-border bg-muted p-3 text-sm whitespace-pre-wrap">{draft.note}</div>
      )}
      {item.error && <div className="text-xs text-amber-700">{item.error}</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {pending && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={dirty || a.approve.isPending}
            title={dirty ? 'Save your edits first' : undefined}
            onClick={() => window.confirm(`Send a LinkedIn connection request with this note to ${draft.toName}? It goes out from your dedicated LinkedIn account (live mode only).`) && a.approve.mutate()}
          >
            <Check className="h-4 w-4" /> Approve
          </Button>
          <Button variant="outline" disabled={!dirty || note.trim().length < 20} onClick={() => a.save.mutate({ note })}>
            <Pencil className="h-4 w-4" /> Save edits
          </Button>
          <Button variant="ghost" onClick={() => a.reject.mutate(null)}>
            <X className="h-4 w-4" /> Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

function AttentionCard({ item }: { item: ReviewItemAny }) {
  const d = item.draft as AttentionDraft;
  const [error, setError] = useState<string | null>(null);
  const a = useReviewActions(item.id, (e) => setError(e.message));
  return (
    <Card className="flex flex-col gap-2 border-amber-400 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
        <AlertTriangle className="size-4" /> {d.title}
      </div>
      <p className="text-sm">{d.message}</p>
      {d.url && <span className="text-xs break-all text-muted-foreground">{d.url}</span>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {item.status === 'pending' && (
        <div>
          <Button onClick={() => a.approve.mutate()} disabled={a.approve.isPending}>
            <Check className="h-4 w-4" /> Fixed — resume
          </Button>
        </div>
      )}
    </Card>
  );
}
