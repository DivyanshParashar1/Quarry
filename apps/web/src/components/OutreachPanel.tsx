import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Search, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getJson, send, type JobOutreach, type ReviewItem } from '@/lib/api';
import { relativeDate } from '@/lib/format';

export function OutreachPanel({ jobId, onOpenReview }: { jobId: string; onOpenReview: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['job-outreach', jobId], queryFn: () => getJson<JobOutreach>(`/api/jobs/${jobId}/outreach`) });
  const [form, setForm] = useState({ name: '', role: '', email: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['job-outreach', jobId] });
  const fail = (e: Error) => setMsg(e.message);

  const add = useMutation({
    mutationFn: () =>
      send('/api/contacts', 'POST', {
        companyId: q.data!.company.id,
        name: form.name.trim(),
        ...(form.role.trim() ? { role: form.role.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      }),
    onSuccess: () => {
      setForm({ name: '', role: '', email: '' });
      setMsg(null);
      refresh();
    },
    onError: fail,
  });
  const enrich = useMutation({
    mutationFn: () => send<{ results: { notes: string[]; emailsSet: number }[] }>('/api/contacts/enrich', 'POST', { companyId: q.data!.company.id }),
    onSuccess: (r) => {
      setMsg(r.results[0] ? `${r.results[0].emailsSet} email(s) inferred. ${r.results[0].notes.join(' ')}` : 'No contacts to enrich.');
      refresh();
    },
    onError: fail,
  });
  const draft = useMutation({
    mutationFn: (contactId: string) => send<ReviewItem>('/api/outreach/draft', 'POST', { contactId, jobId }),
    onSuccess: () => {
      setMsg(null);
      refresh();
      void qc.invalidateQueries({ queryKey: ['review'] });
      void qc.invalidateQueries({ queryKey: ['pipeline'] });
      onOpenReview();
    },
    onError: fail,
  });

  if (q.isPending) return null;
  if (q.error || !q.data) return <p className="text-sm text-red-600">Could not load outreach: {q.error?.message}</p>;
  const { company, contacts, reviewItems, threads } = q.data;
  const open = new Map(reviewItems.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => [r.draft.to, r]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.name.trim()) add.mutate();
  };

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Outreach</h3>
        <span className="text-xs text-muted-foreground">
          {company.emailDomain ?? company.domain ?? 'no domain'}
          {company.emailPattern ? ` · ${company.emailPattern} (${Math.round((company.emailPatternConfidence ?? 0) * 100)}%)` : ''}
        </span>
      </div>
      {contacts.length === 0 && <p className="text-sm text-muted-foreground">No contacts at {company.name} yet. Add the hiring manager or a teammate below.</p>}
      <ul className="flex flex-col gap-1.5">
        {contacts.map((c) => {
          const item = c.email ? open.get(c.email) : undefined;
          const thread = threads.find((t) => t.contactEmail === c.email);
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{c.name}</span>
              {c.role && <span className="text-muted-foreground">{c.role}</span>}
              {c.email ? (
                <span className="text-muted-foreground">
                  {c.email}
                  {c.emailConfidence !== null && c.emailConfidence < 1 ? ` (${Math.round(c.emailConfidence * 100)}%)` : ''}
                </span>
              ) : (
                <Badge variant="outline">no email</Badge>
              )}
              {c.status !== 'active' && <Badge className="bg-red-600 text-white">{c.status}</Badge>}
              <span className="ml-auto">
                {thread ? (
                  <Badge variant="outline">
                    {thread.state} {relativeDate(thread.sentAt)}
                    {thread.followupsSent ? ` · ${thread.followupsSent} follow-up(s)` : ''}
                  </Badge>
                ) : item ? (
                  <Button size="sm" variant="ghost" onClick={onOpenReview}>
                    {item.status === 'pending' ? 'In review' : 'Approved'}
                  </Button>
                ) : (
                  c.email &&
                  c.status === 'active' && (
                    <Button size="sm" variant="outline" onClick={() => draft.mutate(c.id)} disabled={draft.isPending}>
                      <Mail className="h-3.5 w-3.5" /> {draft.isPending && draft.variables === c.id ? 'Drafting…' : 'Draft email'}
                    </Button>
                  )
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" className="h-8 w-36" aria-label="Contact name" />
        <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="Role" className="h-8 w-36" aria-label="Contact role" />
        <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email (if known)" className="h-8 w-44" aria-label="Contact email" />
        <Button size="sm" type="submit" variant="outline" disabled={!form.name.trim() || add.isPending}>
          <UserPlus className="h-3.5 w-3.5" /> Add
        </Button>
        {contacts.some((c) => !c.email || c.emailSource?.startsWith('pattern:')) && (
          <Button size="sm" type="button" variant="ghost" onClick={() => enrich.mutate()} disabled={enrich.isPending}>
            <Search className="h-3.5 w-3.5" /> Find emails
          </Button>
        )}
      </form>
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
    </Card>
  );
}
