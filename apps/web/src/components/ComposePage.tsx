import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Copy, FileText, Loader2, Paperclip, Plus, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  getJson,
  send,
  upload,
  type ComposeContext,
  type ComposeForm,
  type ComposePurpose,
  type ComposeSendResponse,
  type ComposeUpload,
  type ComposeVariant,
  type LibraryPage,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Phase 24: write a personal referral mail. Everything personal comes from
 * what you type (about the receiver, what it's about, your notes in the body,
 * the projects you tick); Generate turns that into two drafts side by side.
 * Send (or Schedule) is the approval. Several recipients = a batch.
 */

type Attachment = { kind: 'upload'; id: string; filename: string; size: number } | { kind: 'resume'; id: string; filename: string };

interface Recipient {
  key: string;
  to: string;
  toName: string;
  company: string;
  receiverInfo: string;
  subject: string;
  body: string;
  attachments: Attachment[];
  variants: ComposeVariant[];
  chosenVariant: number | null;
  /** Your notes, frozen when a draft replaced the body (they still drive regenerations and are logged). */
  notes: string | null;
}

const PURPOSE_LABEL: Record<ComposePurpose, string> = {
  referral: 'Referral ask',
  intro: 'Cold intro',
  followup: 'Follow-up',
  thanks: 'Thank-you',
  chat: 'Coffee chat',
};

const STORAGE_KEY = 'quarry.compose.v1';
const newRecipient = (): Recipient => ({
  key: crypto.randomUUID(),
  to: '',
  toName: '',
  company: '',
  receiverInfo: '',
  subject: '',
  body: '',
  attachments: [],
  variants: [],
  chosenVariant: null,
  notes: null,
});
const defaultForm: ComposeForm = { purpose: 'referral', about: '', projectIds: [], projectNotes: '', tone: 'neutral', length: 'medium' };

function loadDraft(): { form: ComposeForm; recipients: Recipient[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as { form: ComposeForm; recipients: Recipient[] };
    return d.recipients?.length ? { form: { ...defaultForm, ...d.form }, recipients: d.recipients } : null;
  } catch {
    return null;
  }
}

/** The notes the generator should honour: frozen notes once a draft was picked, else the body. */
const notesOf = (r: Recipient) => (r.notes ?? r.body).trim();

export function ComposePage() {
  const qc = useQueryClient();
  const ctx = useQuery({ queryKey: ['compose-context'], queryFn: () => getJson<ComposeContext>('/api/compose/context') });
  const library = useQuery({ queryKey: ['resume-library'], queryFn: () => getJson<LibraryPage>('/api/resumes/library') });
  const saved = useMemo(loadDraft, []);
  const [form, setForm] = useState<ComposeForm>(saved?.form ?? defaultForm);
  const [recipients, setRecipients] = useState<Recipient[]>(saved?.recipients ?? [newRecipient()]);
  const [activeKey, setActiveKey] = useState<string>(recipients[0]!.key);
  const [sendAt, setSendAt] = useState('');
  const [result, setResult] = useState<ComposeSendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [showScript, setShowScript] = useState(false);
  const [lastWasSchedule, setLastWasSchedule] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ form, recipients }));
    } catch {
      // Private window or blocked storage: the draft just isn't kept across reloads.
    }
  }, [form, recipients]);

  const active = recipients.find((r) => r.key === activeKey) ?? recipients[0]!;
  const patch = (key: string, p: Partial<Recipient>) => setRecipients((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  // --- generate -----------------------------------------------------------------
  async function generate(r: Recipient, which?: 0 | 1) {
    const flag = which === undefined ? r.key : `${r.key}:${which}`;
    setGenerating((g) => ({ ...g, [flag]: true }));
    setError(null);
    try {
      const keep = which === undefined ? null : (r.variants[which === 0 ? 1 : 0] ?? null);
      const res = await send<{ variants: ComposeVariant[] }>('/api/compose/generate', 'POST', {
        form,
        recipient: { toName: r.toName, receiverInfo: r.receiverInfo, notes: notesOf(r) },
        count: keep ? 1 : 2,
        keep,
      });
      setRecipients((rs) =>
        rs.map((x) => {
          if (x.key !== r.key) return x;
          // Freeze the notes the first time drafts replace what you typed.
          const notes = x.notes ?? x.body;
          if (keep && which !== undefined) {
            const variants = [...x.variants];
            variants[which] = res.variants[0]!;
            return { ...x, notes, variants, chosenVariant: x.chosenVariant === which ? null : x.chosenVariant };
          }
          return { ...x, notes, variants: res.variants, chosenVariant: null };
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGenerating((g) => ({ ...g, [flag]: false }));
    }
  }

  const pick = (r: Recipient, i: number) => {
    const v = r.variants[i]!;
    patch(r.key, { subject: v.subject, body: v.body, chosenVariant: i, notes: r.notes ?? r.body });
  };

  // --- attachments --------------------------------------------------------------
  const up = useMutation({
    mutationFn: (file: File) => upload<ComposeUpload>('/api/compose/attachments', file),
    onSuccess: (u) => patch(active.key, { attachments: [...active.attachments, { kind: 'upload', id: u.id, filename: u.filename, size: u.size }] }),
    onError: (e: Error) => setError(e.message),
  });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    for (const f of Array.from(e.target.files ?? [])) up.mutate(f);
    e.target.value = '';
  };
  const resumes = (library.data?.resumes ?? []).filter((v) => v.pdfPath && !v.retiredAt && v.status === 'rendered');

  // --- send ---------------------------------------------------------------------
  const sendMut = useMutation({
    mutationFn: (o: { schedule: boolean; ignoreWarnings: boolean }) => {
      setLastWasSchedule(o.schedule);
      return send<ComposeSendResponse>('/api/compose/send', 'POST', {
        form,
        recipients: recipients.map((r) => ({
          to: r.to,
          toName: r.toName,
          company: r.company,
          receiverInfo: r.receiverInfo,
          subject: r.subject,
          body: r.body,
          attachments: r.attachments.map((a) => (a.kind === 'upload' ? { uploadId: a.id } : { resumeVariantId: a.id })),
          variants: r.variants,
          chosenVariant: r.chosenVariant,
          notes: r.notes ?? '',
        })),
        sendAt: o.schedule && sendAt ? new Date(sendAt).toISOString() : null,
        ignoreWarnings: o.ignoreWarnings,
      });
    },
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      const done = res.results.every((r) => r.status === 'sent' || r.status === 'scheduled' || r.status === 'dry_run');
      if (done) {
        const fresh = newRecipient();
        setRecipients([fresh]);
        setActiveKey(fresh.key);
        setSendAt('');
      }
      void qc.invalidateQueries({ queryKey: ['sent-emails'] });
    },
    onError: (e: Error) => setError(e.message),
  });
  const needsConfirm = result?.results.some((r) => r.status === 'warnings') && !result.results.some((r) => r.status === 'blocked');

  const removeRecipient = (key: string) => {
    const rest = recipients.filter((r) => r.key !== key);
    const next = rest.length ? rest : [newRecipient()];
    setRecipients(next);
    if (key === activeKey) setActiveKey(next[0]!.key);
  };

  const live = ctx.data?.mode === 'live';
  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
      {/* ---------------- editor ---------------- */}
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Compose</h2>
          <Badge className={live ? 'bg-good/15 text-foreground' : 'bg-ok/20 text-foreground'}>{live ? 'Live' : 'Dry run — nothing is sent'}</Badge>
          {ctx.data && (
            <span className="text-xs text-muted-foreground">
              {ctx.data.gmail.connected ? `from ${ctx.data.gmail.address}` : 'Gmail not connected (run `quarry gmail auth`)'}
            </span>
          )}
        </div>

        {/* recipients (batch) */}
        <div className="flex flex-wrap items-center gap-1.5">
          {recipients.map((r, i) => (
            <span
              key={r.key}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                r.key === active.key ? 'border-primary bg-muted font-medium' : 'border-border text-muted-foreground',
              )}
            >
              <button onClick={() => setActiveKey(r.key)}>{r.toName || r.to || `Recipient ${i + 1}`}</button>
              {recipients.length > 1 && (
                <button aria-label="Remove recipient" onClick={() => removeRecipient(r.key)}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const r = newRecipient();
              // A new recipient in the batch starts from the current mail as a template.
              setRecipients((rs) => [...rs, { ...r, subject: active.subject, body: active.notes ?? active.body, attachments: active.attachments }]);
              setActiveKey(r.key);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add recipient
          </Button>
        </div>

        <Card className="flex flex-col gap-2 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr]">
            <Input placeholder="To (email)" type="email" value={active.to} onChange={(e) => patch(active.key, { to: e.target.value })} />
            <Input placeholder="Their name" value={active.toName} onChange={(e) => patch(active.key, { toName: e.target.value })} />
            <Input
              placeholder="Company (optional)"
              title="Lets Quarry track replies and the 30-day cooldown for this person"
              value={active.company}
              onChange={(e) => patch(active.key, { company: e.target.value })}
            />
          </div>
          <Input placeholder="Subject" value={active.subject} onChange={(e) => patch(active.key, { subject: e.target.value })} />
          <Textarea
            className="min-h-[260px] font-[inherit]"
            placeholder="Write the mail yourself, or jot down anything that must be in it and press Generate →"
            value={active.body}
            onChange={(e) => patch(active.key, { body: e.target.value })}
          />
          {active.notes !== null && (
            <p className="text-xs text-muted-foreground">
              Your notes (used for generating, and logged): <span className="italic">{active.notes.trim() || '(none)'}</span>{' '}
              <button className="underline" onClick={() => patch(active.key, { notes: active.body })}>
                use the current body as notes
              </button>
            </p>
          )}
          {ctx.data?.signature && <p className="text-xs text-muted-foreground">Signature added on send: {ctx.data.signature.split('\n')[0]}…</p>}

          {/* attachments */}
          <div className="flex flex-wrap items-center gap-1.5">
            {active.attachments.map((a, i) => (
              <span key={`${a.kind}:${a.id}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                {a.kind === 'resume' ? <FileText className="h-3 w-3" /> : <Paperclip className="h-3 w-3" />}
                {a.filename}
                {a.kind === 'upload' && <span className="text-muted-foreground">{Math.ceil(a.size / 1024)} KB</span>}
                <button aria-label="Remove attachment" onClick={() => patch(active.key, { attachments: active.attachments.filter((_, j) => j !== i) })}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input ref={fileRef} type="file" multiple className="hidden" onChange={onFile} />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={up.isPending || active.attachments.length >= 5}>
              {up.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />} Attach file
            </Button>
            {resumes.length > 0 && (
              <select
                className="h-8 rounded-md border border-input bg-card px-2 text-xs"
                value=""
                disabled={active.attachments.length >= 5}
                onChange={(e) => {
                  const v = resumes.find((x) => x.id === e.target.value);
                  if (v) patch(active.key, { attachments: [...active.attachments, { kind: 'resume', id: v.id, filename: `${v.label ?? 'resume'}.pdf` }] });
                }}
              >
                <option value="">Attach a resume…</option>
                {resumes.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label ?? v.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Card>

        {/* send / schedule */}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => sendMut.mutate({ schedule: false, ignoreWarnings: false })} disabled={sendMut.isPending}>
            {sendMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {recipients.length > 1 ? `Send to ${recipients.length}` : 'Send'}
          </Button>
          <span className="text-xs text-muted-foreground">or</span>
          <input
            type="datetime-local"
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
            value={sendAt}
            onChange={(e) => setSendAt(e.target.value)}
            aria-label="Schedule time"
          />
          <Button variant="outline" onClick={() => sendMut.mutate({ schedule: true, ignoreWarnings: false })} disabled={!sendAt || sendMut.isPending}>
            <CalendarClock className="h-4 w-4" /> Schedule
          </Button>
          <button className="text-xs text-muted-foreground underline" onClick={() => setShowScript((s) => !s)}>
            How scheduling works
          </button>
        </div>
        {showScript && <AppsScriptHelp />}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && (
          <Card className="flex flex-col gap-1.5 p-3 text-sm">
            {result.results.map((r) => (
              <div key={r.to}>
                <span className="font-medium">{r.to}</span>: <StatusText status={r.status} />
                {r.error && <span className="text-red-600"> — {r.error}</span>}
                {[...r.blocking, ...r.warnings].map((m) => (
                  <div key={m} className={cn('pl-3 text-xs', r.blocking.includes(m) ? 'text-red-600' : 'text-amber-700')}>
                    • {m}
                  </div>
                ))}
              </div>
            ))}
            {needsConfirm && (
              <div>
                <Button size="sm" variant="outline" onClick={() => sendMut.mutate({ schedule: lastWasSchedule, ignoreWarnings: true })}>
                  {lastWasSchedule ? 'Schedule anyway' : 'Send anyway'}
                </Button>
              </div>
            )}
          </Card>
        )}

        {/* the two drafts, side by side */}
        {active.variants.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {active.variants.map((v, i) => (
              <Card key={i} className={cn('flex flex-col gap-2 p-3', active.chosenVariant === i && 'ring-2 ring-primary')}>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline">{v.angle}</Badge>
                  <span className="text-xs text-muted-foreground">Draft {i + 1}</span>
                </div>
                <div className="text-sm font-medium">{v.subject}</div>
                <div className="max-h-72 overflow-y-auto whitespace-pre-wrap text-sm">{v.body}</div>
                <div className="mt-auto flex gap-2">
                  <Button size="sm" onClick={() => pick(active, i)}>
                    {active.chosenVariant === i ? <Check className="h-3.5 w-3.5" /> : null}
                    {active.chosenVariant === i ? 'In the editor' : 'Use this one'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void generate(active, i as 0 | 1)} disabled={!!generating[`${active.key}:${i}`]}>
                    <RefreshCw className={cn('h-3.5 w-3.5', generating[`${active.key}:${i}`] && 'animate-spin')} /> Regenerate this one
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- generate panel ---------------- */}
      <aside className="flex flex-col gap-3">
        <Card className="flex flex-col gap-3 p-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4" /> Generate
          </h3>
          <label className="flex flex-col gap-1 text-xs font-medium">
            What is it for?
            <div className="flex flex-wrap gap-1">
              {(ctx.data?.purposes ?? (Object.keys(PURPOSE_LABEL) as ComposePurpose[])).map((p) => (
                <Chip key={p} on={form.purpose === p} onClick={() => setForm({ ...form, purpose: p })}>
                  {PURPOSE_LABEL[p]}
                </Chip>
              ))}
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            What is the mail about?
            <Textarea
              className="min-h-[70px] text-sm font-normal"
              placeholder="e.g. Backend Engineer, Payments (req 4411) — I'd love a referral; applied last week."
              value={form.about}
              onChange={(e) => setForm({ ...form, about: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            About {active.toName || 'the receiver'}
            <Textarea
              className="min-h-[90px] text-sm font-normal"
              placeholder="Who they are, how you know them, what you want to reference. Only what you write here is used."
              value={active.receiverInfo}
              onChange={(e) => patch(active.key, { receiverInfo: e.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1 text-xs font-medium">
            Projects to mention
            {(ctx.data?.projects ?? []).length === 0 ? (
              <span className="font-normal text-muted-foreground">No project facts in your profile yet.</span>
            ) : (
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2 font-normal">
                {ctx.data!.projects.map((p) => (
                  <label key={p.id} className="flex items-start gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.projectIds.includes(p.id)}
                      onChange={(e) =>
                        setForm({ ...form, projectIds: e.target.checked ? [...form.projectIds, p.id] : form.projectIds.filter((x) => x !== p.id) })
                      }
                    />
                    <span>
                      <span className="font-medium">{p.id}</span> — {p.content.length > 110 ? `${p.content.slice(0, 110)}…` : p.content}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <Input
              className="text-sm font-normal"
              placeholder="Anything to stress about them (optional)"
              value={form.projectNotes}
              onChange={(e) => setForm({ ...form, projectNotes: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-4 text-xs font-medium">
            <div className="flex flex-col gap-1">
              Tone
              <div className="flex gap-1">
                {(['formal', 'neutral', 'casual'] as const).map((t) => (
                  <Chip key={t} on={form.tone === t} onClick={() => setForm({ ...form, tone: t })}>
                    {t}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              Length
              <div className="flex gap-1">
                {(['short', 'medium', 'full'] as const).map((l) => (
                  <Chip key={l} on={form.length === l} onClick={() => setForm({ ...form, length: l })}>
                    {l}
                  </Chip>
                ))}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {notesOf(active) ? 'Everything in your notes will be in both drafts.' : 'Tip: type must-include points in the body first.'}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void generate(active)} disabled={!!generating[active.key]}>
              {generating[active.key] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {active.variants.length ? 'Regenerate both' : 'Generate 2 drafts'}
            </Button>
            {recipients.length > 1 && (
              <Button variant="outline" onClick={() => recipients.forEach((r) => void generate(r))} disabled={Object.values(generating).some(Boolean)}>
                For all {recipients.length}
              </Button>
            )}
          </div>
        </Card>
      </aside>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('rounded-md border px-2 py-1 text-xs font-normal capitalize', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-muted')}
    >
      {children}
    </button>
  );
}

function StatusText({ status }: { status: string }) {
  const text: Record<string, string> = {
    sent: 'sent',
    dry_run: 'dry run (nothing sent)',
    scheduled: 'scheduled — saved as a Gmail draft',
    blocked: 'not sent',
    warnings: 'check before sending',
    failed: 'failed',
  };
  return <span className={status === 'sent' || status === 'scheduled' ? 'text-good' : status === 'failed' || status === 'blocked' ? 'text-red-600' : ''}>{text[status] ?? status}</span>;
}

function AppsScriptHelp() {
  const script = useQuery({ queryKey: ['apps-script'], queryFn: () => fetch('/api/compose/apps-script').then((r) => r.text()) });
  const [copied, setCopied] = useState(false);
  return (
    <Card className="flex flex-col gap-2 p-3 text-sm">
      <p>
        Gmail's API can't schedule a send, so a scheduled mail is saved as a Gmail <b>draft</b> with its send time, and a small Google Apps Script in your
        Google account sends it on time — even when Quarry is off. One-time setup:
      </p>
      <ol className="list-decimal pl-5 text-xs">
        <li>
          Open{' '}
          <a className="underline" href="https://script.google.com/home/projects/create" target="_blank" rel="noreferrer">
            script.google.com → New project
          </a>
          , replace the code with the script below, save.
        </li>
        <li>Pick the <code>install</code> function, press Run, and allow access to Gmail.</li>
        <li>Done: it checks every 5 minutes and only sends drafts Quarry scheduled. Delete the draft in Gmail (or Cancel in Sent) to unschedule.</li>
      </ol>
      <p className="text-xs text-muted-foreground">Quarry also needs the Gmail drafts permission once: run <code>pnpm quarry gmail auth</code> again if scheduling says it's missing.</p>
      <div className="relative">
        <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-xs">{script.data ?? 'Loading…'}</pre>
        <Button
          size="sm"
          variant="outline"
          className="absolute right-2 top-2"
          onClick={() => {
            if (!script.data) return;
            void navigator.clipboard.writeText(script.data).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Card>
  );
}
