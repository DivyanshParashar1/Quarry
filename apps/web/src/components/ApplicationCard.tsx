import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Pencil, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { send, type ReviewItemAny } from '@/lib/api';
import { relativeDate } from '@/lib/format';

interface Field {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  options?: string[];
  value: string | null;
  source: string | null;
  maxLength?: number;
  /** Phase 19: LLM answers carry a confidence and a note (grounding, or why it was rejected). */
  confidence?: number;
  note?: string;
}
interface AppDraft {
  ats: string;
  title: string;
  company: string;
  jobUrl: string;
  resumePath: string;
  fields: Field[];
  missingRequired: string[];
  previewScreenshots: string[];
}

/** Phase 11: an application draft — every answer visible and editable, nothing invented. */
export function ApplicationCard({ item }: { item: ReviewItemAny }) {
  const d = item.draft as unknown as AppDraft;
  const qc = useQueryClient();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const pending = item.status === 'pending';
  const refresh = () => {
    setEdits({});
    setError(null);
    for (const k of ['review', 'applications', 'pipeline']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const onError = (e: Error) => setError(e.message);
  const saveEdits = () => send(`/api/review/${item.id}`, 'PATCH', { fields: Object.entries(edits).map(([key, value]) => ({ key, value: value.trim() || null })) });
  const save = useMutation({ mutationFn: saveEdits, onSuccess: refresh, onError });
  // Unsaved edits are saved first, so one click both records the answers and approves.
  const approve = useMutation({
    mutationFn: async () => {
      if (Object.keys(edits).length) await saveEdits();
      return send(`/api/review/${item.id}/approve`, 'POST', {});
    },
    onSuccess: refresh,
    onError,
  });
  const reject = useMutation({ mutationFn: () => send(`/api/review/${item.id}/reject`, 'POST', {}), onSuccess: refresh, onError });
  const dirty = Object.keys(edits).length > 0;
  // Required questions still blank once the unsaved edits are counted.
  const stillMissing = d.fields.filter((f) => f.required && !(f.key in edits ? edits[f.key]!.trim() : f.value)).map((f) => f.label);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge className="capitalize">{item.status}</Badge>
        <Badge variant="outline">
          <FileText className="mr-1 size-3" /> Application · {d.ats}
        </Badge>
        <a className="font-medium underline" href={d.jobUrl} target="_blank" rel="noreferrer noopener">
          {d.title}
        </a>
        <span className="text-muted-foreground">
          {d.company} · drafted {relativeDate(item.createdAt)}
        </span>
      </div>
      {d.missingRequired.length > 0 && (
        <div className="rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900">
          Answer before approving: {d.missingRequired.join(' · ')}
        </div>
      )}
      <table className="w-full text-sm">
        <tbody>
          {d.fields.map((f) => (
            <tr key={f.key} className="border-b border-border last:border-0">
              <td className="w-2/5 py-1 pr-2 align-top">
                {f.label}
                {f.required && <span className="text-red-600"> *</span>}
              </td>
              <td className="py-1">
                {f.kind === 'file' ? (
                  <span className="text-xs break-all text-muted-foreground">{f.value ?? '—'}</span>
                ) : pending ? (
                  f.options?.length ? (
                    <select
                      className="w-full rounded border border-input bg-card px-2 py-1"
                      value={edits[f.key] ?? f.value ?? ''}
                      onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                    >
                      <option value="">— leave blank —</option>
                      {f.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : f.kind === 'textarea' ? (
                    <Textarea
                      rows={4}
                      maxLength={f.maxLength}
                      value={edits[f.key] ?? f.value ?? ''}
                      onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                    />
                  ) : (
                    <Input value={edits[f.key] ?? f.value ?? ''} onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })} />
                  )
                ) : (
                  <span className="whitespace-pre-wrap">{f.value ?? '—'}</span>
                )}
                {f.note && (
                  <div className={f.note.startsWith('LLM answer rejected') ? 'mt-0.5 text-xs text-amber-700' : 'mt-0.5 text-xs text-muted-foreground'}>{f.note}</div>
                )}
              </td>
              <td className="w-20 py-1 pl-2 text-right align-top text-xs text-muted-foreground">
                {f.source === 'llm' ? (
                  <Badge variant="outline" className={(f.confidence ?? 0) < 0.85 ? 'border-amber-600 text-amber-700' : ''} title="Written by the LLM from your facts and the job description — read it before approving">
                    LLM {Math.round((f.confidence ?? 0) * 100)}%
                  </Badge>
                ) : f.source === 'bank' ? (
                  <span title="An answer you approved on an earlier application">saved</span>
                ) : (
                  (f.source ?? '')
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.previewScreenshots.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">Preview of the filled form ({d.previewScreenshots.length})</summary>
          {d.previewScreenshots.map((_, n) => (
            <img key={n} className="mt-2 w-full rounded border" src={`/api/review/${item.id}/screenshots/${n}`} alt={`filled form preview ${n + 1}`} />
          ))}
        </details>
      )}
      {item.error && <div className="text-xs text-amber-700">{item.error}</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {pending && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={stillMissing.length > 0 || approve.isPending || save.isPending}
            title={stillMissing.length ? `Answer the required questions first: ${stillMissing.join(' · ')}` : undefined}
            onClick={() => window.confirm(`Submit this application to ${d.company} (${d.ats})? It is filled and submitted from a browser once approved (live mode only).`) && approve.mutate()}
          >
            <Check className="h-4 w-4" /> {dirty ? 'Save & approve' : 'Approve'}
          </Button>
          <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            <Pencil className="h-4 w-4" /> Save answers
          </Button>
          <Button variant="ghost" onClick={() => reject.mutate()}>
            <X className="h-4 w-4" /> Reject
          </Button>
        </div>
      )}
    </Card>
  );
}
