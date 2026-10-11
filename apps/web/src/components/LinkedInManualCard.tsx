import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, FileText, MessageSquareReply, Network, Pencil, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { send, type LinkedInManualDraft, type ReviewStatus } from '@/lib/api';
import { relativeDate } from '@/lib/format';

export interface LinkedInManualItem {
  id: string;
  status: ReviewStatus;
  draft: LinkedInManualDraft;
  companyName: string | null;
  jobTitle: string | null;
  createdAt: string;
  /** The resume PDF to attach (messages). */
  resumePdf: string | null;
  error?: string | null;
  /** The thread's state once sent (to offer "They replied"). */
  threadState?: 'sent' | 'replied' | 'bounced' | 'closed' | null;
}

const NOTE_MAX = 300;
const MESSAGE_MAX = 1500;

/**
 * Phase 17: a LinkedIn message (to a connection) or connection-request note that
 * you send yourself. Copy it, open the profile, attach the PDF, then "I sent it".
 */
export function LinkedInManualCard({ item }: { item: LinkedInManualItem }) {
  const qc = useQueryClient();
  const d = item.draft;
  const [text, setText] = useState(d.text);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    for (const k of ['review', 'job-referrals', 'linkedin-drafts', 'pipeline', 'job-outreach']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const onError = (e: Error) => setError(e.message);
  const save = useMutation({ mutationFn: () => send(`/api/review/${item.id}`, 'PATCH', { text }), onSuccess: refresh, onError });
  const sent = useMutation({ mutationFn: () => send(`/api/linkedin/drafts/${item.id}/sent`, 'POST', {}), onSuccess: refresh, onError });
  const replied = useMutation({ mutationFn: () => send(`/api/linkedin/drafts/${item.id}/replied`, 'POST', {}), onSuccess: refresh, onError });
  const reject = useMutation({ mutationFn: () => send(`/api/review/${item.id}/reject`, 'POST', { reason: 'not sending' }), onSuccess: refresh, onError });

  const open = item.status === 'pending' || item.status === 'approved';
  const editable = item.status === 'pending';
  const dirty = text !== d.text;
  const max = d.kind === 'note' ? NOTE_MAX : MESSAGE_MAX;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed; select the text and copy it by hand.');
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge className="capitalize">{item.status === 'executed' ? 'sent by you' : item.status}</Badge>
        <Badge variant="outline">
          <Network className="mr-1 size-3" />{' '}
          {d.purpose === 'followup' ? 'LinkedIn follow-up' : d.purpose === 'after_accept' ? 'LinkedIn message · accepted your request' : d.kind === 'message' ? 'LinkedIn message · connection' : 'LinkedIn connection note'}
        </Badge>
        <a className="font-medium underline" href={d.profileUrl} target="_blank" rel="noreferrer noopener">
          {d.toName}
        </a>
        <span className="text-muted-foreground">
          {item.companyName}
          {item.jobTitle ? ` · ${item.jobTitle}` : ''} · drafted {relativeDate(item.createdAt)}
        </span>
        {item.threadState === 'replied' && <Badge className="bg-emerald-100 text-emerald-900">replied</Badge>}
      </div>
      {editable ? (
        <>
          <Textarea value={text} maxLength={max} rows={d.kind === 'note' ? 4 : 8} onChange={(e) => setText(e.target.value)} aria-label="LinkedIn text" />
          <span className="text-xs text-muted-foreground">
            {text.length}/{max} characters{d.kind === 'note' ? " (LinkedIn's note limit)" : ''}
          </span>
        </>
      ) : (
        <div className="rounded-md border border-border bg-muted p-3 text-sm whitespace-pre-wrap">{d.text}</div>
      )}
      {item.error && <div className="text-xs text-amber-700">{item.error}</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      <div className="flex flex-wrap gap-2">
        {open && (
          <>
            <Button variant="outline" onClick={() => void copy()} disabled={dirty} title={dirty ? 'Save your edits first' : undefined}>
              <Copy className="h-4 w-4" /> {copied ? 'Copied' : 'Copy text'}
            </Button>
            <a className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input px-3 text-sm hover:bg-muted" href={d.profileUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="h-4 w-4" /> Open profile
            </a>
            {d.kind === 'message' && item.resumePdf && (
              <a className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input px-3 text-sm hover:bg-muted" href={item.resumePdf} download="resume.pdf">
                <FileText className="h-4 w-4" /> Download resume PDF
              </a>
            )}
            <Button
              disabled={dirty || sent.isPending}
              title={dirty ? 'Save your edits first' : 'Record that you sent it on LinkedIn'}
              onClick={() => window.confirm(`Did you send this ${d.kind} to ${d.toName} on LinkedIn?`) && sent.mutate()}
            >
              <Check className="h-4 w-4" /> I sent it
            </Button>
          </>
        )}
        {editable && (
          <Button variant="outline" disabled={!dirty || text.trim().length < 20 || save.isPending} onClick={() => save.mutate()}>
            <Pencil className="h-4 w-4" /> Save edits
          </Button>
        )}
        {open && (
          <Button variant="ghost" onClick={() => reject.mutate()}>
            <X className="h-4 w-4" /> Skip
          </Button>
        )}
        {item.status === 'executed' && item.threadState !== 'replied' && (
          <Button variant="outline" onClick={() => replied.mutate()} disabled={replied.isPending}>
            <MessageSquareReply className="h-4 w-4" /> They replied
          </Button>
        )}
      </div>
      {d.kind === 'message' && open && (
        <p className="text-xs text-muted-foreground">The message says your resume is attached: attach the downloaded PDF in the LinkedIn chat before sending.</p>
      )}
    </Card>
  );
}
