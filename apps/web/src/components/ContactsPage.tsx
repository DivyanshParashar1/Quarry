import { useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { LinkedInManualCard } from '@/components/LinkedInManualCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  getJson,
  send,
  upload,
  type ContactImportSummary,
  type ImportPreview,
  type ImportResult,
  type LinkedInDraftEntry,
} from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Phase 17: import contact sheets (any .xlsx/.csv, or LinkedIn's Connections
 * export) with an EDA report before anything is written, and the queue of
 * LinkedIn messages/notes waiting for you to send by hand.
 */
export function ContactsPage() {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imports = useQuery({ queryKey: ['contact-imports'], queryFn: () => getJson<{ imports: ContactImportSummary[] }>('/api/contacts/imports') });
  const drafts = useQuery({ queryKey: ['linkedin-drafts', 'all'], queryFn: () => getJson<{ drafts: LinkedInDraftEntry[] }>('/api/linkedin/drafts') });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['contact-imports'] });
    void qc.invalidateQueries({ queryKey: ['job-referrals'] });
  };
  const up = useMutation({
    mutationFn: (file: File) => upload<ImportPreview>('/api/contacts/import', file),
    onSuccess: (p) => {
      setPreview(p);
      setResult(null);
      setError(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const commit = useMutation({
    mutationFn: (id: string) => send<ImportResult>(`/api/contacts/imports/${id}/commit`, 'POST', {}),
    onSuccess: (r) => {
      setResult(r);
      setPreview(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const discard = useMutation({
    mutationFn: (id: string) => send(`/api/contacts/imports/${id}/discard`, 'POST', {}),
    onSuccess: () => {
      setPreview(null);
      refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const openPreview = useMutation({
    mutationFn: (id: string) => getJson<ImportPreview>(`/api/contacts/imports/${id}`),
    onSuccess: (p) => {
      setPreview(p);
      setResult(null);
    },
  });

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) up.mutate(f);
    e.target.value = '';
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4">
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Import contacts</h2>
          <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Upload className="h-4 w-4" /> {up.isPending ? 'Analysing…' : 'Upload .xlsx / .csv'}
            <input type="file" accept=".xlsx,.xlsm,.csv,.tsv" className="hidden" onChange={onFile} disabled={up.isPending} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Any sheet of people works (messy headers, merged cells and duplicates are handled). For your LinkedIn connections: LinkedIn →
          Settings → Data privacy → Get a copy of your data → Connections, then upload <code>Connections.csv</code>; they get a direct
          message (sent by you) when they work at a company you apply to. Nothing is written until you press Import.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && (
          <p className="text-sm">
            Imported: {result.contactsCreated} new, {result.contactsUpdated} updated contacts · {result.companiesCreated} new companies ·{' '}
            {result.skipped.length} rows skipped.
          </p>
        )}
      </Card>

      {preview && (
        <PreviewView
          preview={preview}
          busy={commit.isPending || discard.isPending}
          onCommit={() => commit.mutate(preview.importId)}
          onDiscard={() => discard.mutate(preview.importId)}
        />
      )}

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold">LinkedIn to send ({drafts.data?.drafts.length ?? 0})</h2>
        <p className="text-xs text-muted-foreground">
          Drafted by referral fan-outs. Copy each one into LinkedIn yourself (attach the resume for messages), then press "I sent it" so the
          30-day cooldown, the job's referral batch and the apply timing stay correct.
        </p>
        {drafts.data?.drafts.map((d) => (
          <LinkedInManualCard
            key={d.id}
            item={{ id: d.id, status: d.status, draft: d.linkedin, companyName: d.companyName, jobTitle: d.linkedin.jobTitle, createdAt: d.createdAt, resumePdf: d.resumePdf }}
          />
        ))}
        {drafts.data && !drafts.data.drafts.length && <p className="text-sm text-muted-foreground">Nothing waiting.</p>}
      </Card>

      {(imports.data?.imports.length ?? 0) > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">Recent imports</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {imports.data!.imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{i.status}</Badge>
                <span className="font-medium">{i.filename.replace(/^.*[\\/]/, '')}</span>
                <span className="text-muted-foreground">
                  {i.format === 'linkedin_connections' ? 'LinkedIn export' : 'sheet'} · {i.report.rows.importable}/{i.report.rows.total} importable
                  {i.result ? ` · ${i.result.contactsCreated} new, ${i.result.contactsUpdated} updated` : ''} · {relativeDate(i.createdAt)}
                </span>
                {i.status === 'preview' && (
                  <Button size="sm" variant="ghost" onClick={() => openPreview.mutate(i.id)}>
                    Open preview
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const VIA_TONE: Record<string, string> = { header: '', values: 'text-sky-700', llm: 'text-violet-700', none: 'text-red-600' };

function PreviewView({ preview: p, busy, onCommit, onDiscard }: { preview: ImportPreview; busy: boolean; onCommit: () => void; onDiscard: () => void }) {
  const r = p.report;
  const stat = (label: string, value: string | number, bad = false) => (
    <div className="rounded-md border border-border px-3 py-2">
      <div className={cn('text-base font-semibold', bad && 'text-red-600')}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{p.filename.replace(/^.*[\\/]/, '')}</h2>
        <Badge variant="outline">{r.format === 'linkedin_connections' ? 'LinkedIn Connections export' : 'contact sheet'}</Badge>
        <span className="text-xs text-muted-foreground">
          sheet "{r.sheet}"{r.sheets.length > 1 ? ` (of ${r.sheets.length})` : ''} · header on row {r.headerRow}
          {r.groupHeaderRows.length ? ` · merged group header on row ${r.groupHeaderRows.join(', ')}` : ''}
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          <Button onClick={onCommit} disabled={busy || r.rows.importable === 0}>
            Import {r.rows.importable} contacts
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {stat('rows', r.rows.total)}
        {stat('importable', r.rows.importable)}
        {stat('skipped', r.rows.skipped, r.rows.skipped > 0)}
        {stat('duplicates merged', r.duplicates.byLinkedin + r.duplicates.byEmail + r.duplicates.byNameCompany)}
        {stat('invalid emails', r.invalidEmails.count, r.invalidEmails.count > 0)}
        {stat('unreachable', r.missing.reachable, r.missing.reachable > 0)}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="p-1 text-left font-normal">Column</th>
              <th className="p-1 text-left font-normal">Read as</th>
              <th className="p-1 text-left font-normal">How</th>
              <th className="p-1 text-right font-normal">Filled</th>
              <th className="p-1 text-left font-normal">Examples</th>
            </tr>
          </thead>
          <tbody>
            {r.columns.map((c) => (
              <tr key={c.index} className="border-t border-border">
                <td className="p-1">{c.header || `#${c.index + 1}`}</td>
                <td className={cn('p-1 font-medium', c.type === 'ignore' && 'text-muted-foreground')}>{c.type}</td>
                <td className={cn('p-1', VIA_TONE[c.via])}>{c.via === 'llm' ? 'LLM' : c.via}</td>
                <td className="p-1 text-right">{Math.round(c.fillRate * 100)}%</td>
                <td className="max-w-[24rem] truncate p-1 text-muted-foreground">{c.sample.slice(0, 3).join(' | ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="text-xs">
          <h3 className="mb-1 font-medium">Companies ({p.companies.length})</h3>
          <ul className="flex flex-col gap-0.5">
            {p.companies.slice(0, 15).map((m) => (
              <li key={m.name}>
                {m.name} <span className="text-muted-foreground">({m.rows})</span> →{' '}
                {m.companyId ? (
                  <span>
                    {m.matchedName} <span className="text-muted-foreground">[{m.via === 'email_domain' ? 'email domain' : 'name'}]</span>
                  </span>
                ) : (
                  <span className="text-amber-700">new company</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="text-xs">
          <h3 className="mb-1 font-medium">Cleaning</h3>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            <li>
              Names: {r.nameFormats.splitColumns} from first/last columns, {r.nameFormats.firstLast} "First Last", {r.nameFormats.lastCommaFirst} "Last, First"
              (reordered), {r.nameFormats.allCaps} ALL CAPS (title-cased), {r.nameFormats.singleWord} single word
            </li>
            <li>
              Duplicates merged: {r.duplicates.byLinkedin} by LinkedIn URL, {r.duplicates.byEmail} by email, {r.duplicates.byNameCompany} by name + company
            </li>
            <li>
              Missing: {r.missing.company} company, {r.missing.email} email, {r.missing.linkedin} LinkedIn
            </li>
            {r.invalidEmails.examples.length > 0 && <li>Invalid emails (dropped): {r.invalidEmails.examples.join(', ')}</li>}
            {r.warnings.map((w) => (
              <li key={w} className="text-amber-700">
                {w}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {p.problems.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Rows with problems ({p.problems.length})</summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs">
            {p.problems.map((row) => (
              <li key={row.line} className={row.action === 'skip' ? 'text-red-600' : 'text-amber-700'}>
                row {row.line}{row.name ? ` (${row.name})` : ''}: {row.problems.join('; ')} {row.action === 'skip' ? '— skipped' : '— imported'}
              </li>
            ))}
          </ul>
        </details>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">First {p.sample.length} rows as they will be imported</summary>
        <table className="mt-1 w-full text-xs">
          <tbody>
            {p.sample.map((row) => (
              <tr key={row.line} className="border-t border-border">
                <td className="p-1 text-muted-foreground">{row.line}</td>
                <td className="p-1 font-medium">{row.name}</td>
                <td className="p-1">{row.company}</td>
                <td className="p-1">{row.title}</td>
                <td className="p-1">{row.email ?? '—'}</td>
                <td className="max-w-[14rem] truncate p-1">{row.linkedinUrl ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );
}
