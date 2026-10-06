import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FixableField } from '@/components/FixableField';
import {
  FACT_KINDS,
  getJson,
  send,
  upload,
  type FactDraft,
  type FactKind,
  type FullProfile,
  type Preferences,
  type ProfileFact,
} from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'facts' | 'preferences' | 'import';

const KIND_ORDER: FactKind[] = ['experience', 'project', 'education', 'achievement', 'skill'];

export function ProfilePage() {
  const [tab, setTab] = useState<Tab>('facts');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['profile-full'], queryFn: () => getJson<FullProfile>('/api/profile/full') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['profile-full'] });

  if (q.isPending) return <div className="p-6 text-sm text-muted-foreground">Loading profile…</div>;
  if (q.error || !q.data)
    return (
      <div className="p-6 text-sm text-red-600">
        Could not load profile: {(q.error as Error | undefined)?.message ?? 'unknown error'}.{' '}
        Make sure the server was started from the repo root and <code>profile/</code> exists.
      </div>
    );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Your profile</h1>
        <nav className="flex gap-1 text-sm">
          {(['facts', 'preferences', 'import'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-current={tab === t}
              className={cn(
                'rounded-md px-2.5 py-1 capitalize',
                tab === t ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'facts' && <FactsSection facts={q.data.facts} onChanged={refresh} />}
      {tab === 'preferences' && <PreferencesSection preferences={q.data.preferences} onChanged={refresh} />}
      {tab === 'import' && <ImportSection onImported={refresh} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function FactsSection({ facts, onChanged }: { facts: ProfileFact[]; onChanged: () => void }) {
  const grouped = new Map<FactKind, ProfileFact[]>();
  for (const kind of KIND_ORDER) grouped.set(kind, []);
  for (const f of facts) grouped.get(f.kind)?.push(f);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Everything you list here is the ground truth. The tailor only selects, reorders, and rephrases these facts
        for each job — it never invents experience. Add numbers to the Metrics field so the validator can preserve them.
      </p>
      <NewFactCard onCreated={onChanged} />
      {KIND_ORDER.map((kind) => {
        const list = grouped.get(kind) ?? [];
        if (!list.length) return null;
        return (
          <section key={kind}>
            <h2 className="mb-2 text-sm font-semibold capitalize">{kind} ({list.length})</h2>
            <ul className="flex flex-col gap-2">
              {list.map((f) => (
                <FactCard key={f.id} fact={f} onChanged={onChanged} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function FactCard({ fact, onChanged }: { fact: ProfileFact; onChanged: () => void }) {
  const [content, setContent] = useState(fact.content);
  const [tags, setTags] = useState(fact.tags.join(', '));
  const [metrics, setMetrics] = useState(JSON.stringify(fact.metrics));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setContent(fact.content);
    setTags(fact.tags.join(', '));
    setMetrics(JSON.stringify(fact.metrics));
  }, [fact.id, fact.content, fact.tags, fact.metrics]);

  const save = useMutation({
    mutationFn: () => {
      let parsedMetrics: Record<string, string | number | boolean>;
      try {
        parsedMetrics = metrics.trim() ? JSON.parse(metrics) : {};
      } catch {
        throw new Error('metrics must be valid JSON');
      }
      return send(`/api/profile/facts/${encodeURIComponent(fact.id)}`, 'PATCH', {
        content: content.trim(),
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        metrics: parsedMetrics,
      });
    },
    onSuccess: () => {
      setErr(null);
      onChanged();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const del = useMutation({
    mutationFn: () => send(`/api/profile/facts/${encodeURIComponent(fact.id)}`, 'DELETE'),
    onSuccess: onChanged,
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="outline">{fact.kind}</Badge>
          <code className="text-xs text-muted-foreground">{fact.id}</code>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Delete fact "${fact.id}"? Any resume variants still cite it.`)) del.mutate();
          }}
          disabled={del.isPending}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <FixableField value={content} onChange={setContent} kind={`resume ${fact.kind}`} multiline rows={3} />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Tags (comma-separated)</span>
          <Input value={tags} onChange={(e) => setTags(e.currentTarget.value)} placeholder="go, postgres, payments" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Metrics (JSON)</span>
          <Input value={metrics} onChange={(e) => setMetrics(e.currentTarget.value)} placeholder='{"users": 10000}' />
        </label>
      </div>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

function NewFactCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [kind, setKind] = useState<FactKind>('project');
  const [content, setContent] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => send('/api/profile/facts', 'POST', { id: id.trim(), kind, content: content.trim(), metrics: {}, tags: [] }),
    onSuccess: () => {
      setId('');
      setContent('');
      setErr(null);
      setOpen(false);
      onCreated();
    },
    onError: (e: Error) => setErr(e.message),
  });
  if (!open)
    return (
      <Button variant="outline" onClick={() => setOpen(true)} className="self-start">
        <Plus className="h-3.5 w-3.5" /> Add fact
      </Button>
    );
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr]">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Id (stable, kebab-case; never reuse)</span>
          <Input value={id} onChange={(e) => setId(e.currentTarget.value)} placeholder="proj-ledger-service" />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value as FactKind)}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            {FACT_KINDS.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>
      <FixableField value={content} onChange={setContent} kind={`resume ${kind}`} multiline rows={3} placeholder="Backend engineer at Acme. Built the payments ledger in Go on Postgres, handling 2M transactions/day." />
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" onClick={() => create.mutate()} disabled={!id.trim() || !content.trim() || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PreferencesSection({ preferences, onChanged }: { preferences: Preferences; onChanged: () => void }) {
  const [p, setP] = useState<Preferences>(preferences);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setP(preferences), [preferences]);

  const save = useMutation({
    mutationFn: () => send('/api/profile/preferences', 'PUT', p),
    onSuccess: () => {
      setErr(null);
      onChanged();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const setList = (key: keyof Preferences) => (e: ChangeEvent<HTMLInputElement>) =>
    setP({ ...p, [key]: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) });

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold">Preferences</h2>
      <p className="text-xs text-muted-foreground">
        What the matcher filters on and ranks against. Comma-separated lists.
      </p>
      <ListField label="Target roles" value={p.roles} onChange={setList('roles')} placeholder="Backend Engineer, Platform Engineer" />
      <ListField label="Levels" value={p.seniority} onChange={setList('seniority')} placeholder="junior, mid, senior" />
      <ListField label="Preferred locations" value={p.locations} onChange={setList('locations')} placeholder="Bengaluru, Remote" />
      <ListField label="Work arrangement" value={p.remote_policy} onChange={setList('remote_policy')} placeholder="remote, hybrid, onsite" />
      <ListField label="Tech stack" value={p.stack} onChange={setList('stack')} placeholder="go, postgres, kafka" />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Years of experience</span>
          <Input
            type="number"
            value={p.experience_years ?? ''}
            onChange={(e) => setP({ ...p, experience_years: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Graduation year</span>
          <Input
            type="number"
            value={p.graduation_year ?? ''}
            onChange={(e) => setP({ ...p, graduation_year: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
          />
        </label>
      </div>
      <SalaryField value={p.salary_floor} onChange={(sf) => setP({ ...p, salary_floor: sf })} />
      <ListField
        label="Excluded companies"
        value={p.exclusions.companies}
        onChange={(e) => setP({ ...p, exclusions: { ...p.exclusions, companies: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
        placeholder="EvilCorp"
      />
      <ListField
        label="Excluded title keywords"
        value={p.exclusions.title_keywords}
        onChange={(e) => setP({ ...p, exclusions: { ...p.exclusions, title_keywords: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
        placeholder="intern, contract"
      />
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Notes (anything else the matcher should weigh)</span>
        <Textarea value={p.notes ?? ''} onChange={(e) => setP({ ...p, notes: e.currentTarget.value || null })} rows={3} />
      </label>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save preferences'}
        </Button>
      </div>
    </Card>
  );
}

function ListField({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (e: ChangeEvent<HTMLInputElement>) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input value={value.join(', ')} onChange={onChange} placeholder={placeholder} />
    </label>
  );
}

function SalaryField({ value, onChange }: { value: Preferences['salary_floor']; onChange: (v: Preferences['salary_floor']) => void }) {
  const v = value ?? { amount: 0, currency: 'INR', period: 'year' as const };
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Salary floor (amount)</span>
        <Input
          type="number"
          value={value?.amount ?? ''}
          onChange={(e) => onChange(e.currentTarget.value ? { ...v, amount: Number(e.currentTarget.value) } : null)}
          placeholder="2500000"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Currency</span>
        <Input value={v.currency} onChange={(e) => value && onChange({ ...v, currency: e.currentTarget.value })} disabled={!value} />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Period</span>
        <select
          value={v.period}
          onChange={(e) => value && onChange({ ...v, period: e.currentTarget.value as 'year' | 'month' })}
          className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          disabled={!value}
        >
          <option value="year">year</option>
          <option value="month">month</option>
        </select>
      </label>
      {value && (
        <Button variant="ghost" size="sm" onClick={() => onChange(null)} className="self-end">
          Clear
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import (resume PDF -> LLM fact drafts -> user confirms per-row)
// ---------------------------------------------------------------------------

function ImportSection({ onImported }: { onImported: () => void }) {
  const [drafts, setDrafts] = useState<FactDraft[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const extract = useMutation({
    mutationFn: (file: File) => upload<{ drafts: FactDraft[] }>('/api/profile/import', file),
    onSuccess: (r) => {
      setDrafts(r.drafts);
      setErr(null);
      setStatus(`Extracted ${r.drafts.length} fact drafts. Review and keep the ones that are right.`);
    },
    onError: (e: Error) => setErr(e.message),
  });

  const commit = useMutation({
    mutationFn: async () => {
      let saved = 0;
      for (const d of drafts) {
        await send('/api/profile/facts', 'POST', d);
        saved++;
      }
      return saved;
    },
    onSuccess: (n) => {
      setStatus(`Saved ${n} facts to profile/facts.yaml.`);
      setDrafts([]);
      onImported();
    },
    onError: (e: Error) => setErr(e.message),
  });

  const onFile = (e: FormEvent<HTMLInputElement>) => {
    const f = e.currentTarget.files?.[0];
    if (f) extract.mutate(f);
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-semibold">Import from your resume</h2>
      <p className="text-xs text-muted-foreground">
        Upload a resume PDF; the LLM extracts a fact-bank draft (one row per project / role / degree / skill group).
        You review the drafts, drop or edit any that look wrong, then save them to <code>profile/facts.yaml</code>.
      </p>
      <label className="flex items-center gap-2 self-start">
        <input type="file" accept="application/pdf,.pdf" onChange={onFile} className="text-xs" />
        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
      </label>
      {extract.isPending && <p className="text-sm text-muted-foreground">Parsing PDF and extracting facts…</p>}
      {status && <p className="text-sm text-muted-foreground">{status}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {drafts.length > 0 && (
        <>
          <ul className="flex flex-col gap-2">
            {drafts.map((d, i) => (
              <li key={d.id} className="rounded-md border border-input p-3 text-sm">
                <div className="mb-1 flex items-center gap-2">
                  <Badge variant="outline">{d.kind}</Badge>
                  <code className="text-xs text-muted-foreground">{d.id}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
                    className="ml-auto"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Drop
                  </Button>
                </div>
                <FixableField
                  value={d.content}
                  onChange={(next) => setDrafts(drafts.map((x, j) => (j === i ? { ...x, content: next } : x)))}
                  kind={`resume ${d.kind}`}
                  multiline
                  rows={2}
                />
                {d.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.tags.map((t) => (
                      <Badge key={t} variant="outline" className="text-xs">
                        {t}
                      </Badge>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setDrafts([])}>Discard all</Button>
            <Button size="sm" onClick={() => commit.mutate()} disabled={commit.isPending}>
              <RefreshCw className={cn('h-3.5 w-3.5', commit.isPending && 'animate-spin')} />
              {commit.isPending ? 'Saving…' : `Save ${drafts.length} to profile`}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
