import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AtsScoreCard } from '@/components/AtsScoreCard';
import {
  getJson,
  send,
  type JobResumes,
  type JobResumeSelection,
  type ResumeVariant,
  type SelectorDecision,
  type SelectResponse,
} from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

export const STATUS_STYLE: Record<ResumeVariant['status'], string> = {
  rendered: 'bg-good text-black',
  validation_failed: 'bg-weak text-black',
  render_failed: 'bg-ok text-black',
  overflow: 'bg-weak text-black',
};

const ISSUE_STYLE = {
  ok: 'text-muted-foreground',
  warning: 'text-amber-600',
  error: 'text-red-600',
} as const;

export function ResumePanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['resume-variants', jobId],
    queryFn: () => getJson<JobResumes>(`/api/jobs/${jobId}/resume-variants`),
  });
  const select = useMutation({
    mutationFn: (force: boolean) => send<SelectResponse>(`/api/jobs/${jobId}/tailor`, 'POST', { force }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resume-variants', jobId] });
      void qc.invalidateQueries({ queryKey: ['job-outreach', jobId] });
    },
  });

  const variants = q.data?.variants ?? [];
  const selection = q.data?.selection ?? null;
  const chosen = selection?.chosen ?? null;
  const others = variants.filter((v) => v.id !== chosen?.id);

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Resume for this job</h3>
        <div className="flex gap-2">
          {!selection && (
            <Button size="sm" variant="outline" onClick={() => select.mutate(false)} disabled={select.isPending}>
              <RefreshCw className={cn('h-3.5 w-3.5', select.isPending && 'animate-spin')} />
              Pick resume
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => select.mutate(true)}
            disabled={select.isPending}
            title="Re-pick the best library resume and rewrite its Technical Skills for this job"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', select.isPending && 'animate-spin')} />
            Generate new
          </Button>
        </div>
      </div>
      {select.isPending && (
        <p className="text-sm text-muted-foreground">Scoring the library against this JD, rewriting the skills and compiling…</p>
      )}
      {select.error && <p className="text-sm text-red-600">{(select.error as Error).message}</p>}
      {!selection && !variants.length && !select.isPending && (
        <p className="text-sm text-muted-foreground">
          No resume picked yet. The selector scores every library resume (Resumes tab) against this JD, picks the best,
          then rewrites only its Technical Skills for the job — kept if the ATS score doesn't drop.
        </p>
      )}
      {selection && <SelectionSummary selection={selection} />}
      {chosen ? <VariantCard variant={chosen} /> : !selection && variants[0] && <VariantCard variant={variants[0]} />}
      {(selection ? others : variants.slice(1)).length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {(selection ? others : variants.slice(1)).length} other version(s) for this job
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {(selection ? others : variants.slice(1)).map((v) => (
              <li key={v.id} className="text-xs text-muted-foreground">
                <Badge className={STATUS_STYLE[v.status]}>{v.status.replace('_', ' ')}</Badge> {v.kind}
                {v.atsScore && ` · ATS ${v.atsScore.score}`} · {relativeDate(v.createdAt)}
                {v.pdfPath && (
                  <>
                    {' · '}
                    <a className="underline" href={`/api/resume-variants/${v.id}/pdf`} target="_blank" rel="noreferrer noopener">
                      PDF
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

const KEPT_LABEL: Record<SelectorDecision['kept'], string> = {
  tailored: 'library combo + skills tailored to this job',
  combo: 'library combo as-is',
  generated: 'generated for this job',
};

function SelectionSummary({ selection }: { selection: JobResumeSelection }) {
  const d = selection.decision;
  const keptAts = d.kept === 'combo' ? d.comboAts : (d.tailoredAts ?? d.comboAts);
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{selection.combo?.label ?? selection.chosen?.label ?? 'Resume'}</span>
        <span className="text-muted-foreground">· {KEPT_LABEL[d.kept]}</span>
        {selection.selectorScore !== null && <Badge variant="outline">selector {selection.selectorScore}</Badge>}
        {d.weakFit && <Badge className="bg-weak text-black">weak fit</Badge>}
        {d.category && <Badge variant="outline">{d.category}</Badge>}
        <span className="text-muted-foreground">· {relativeDate(selection.decidedAt)}</span>
      </div>
      {d.note && <p className="text-xs text-muted-foreground">{d.note}</p>}
      {keptAts && <AtsScoreCard ats={keptAts} title={`ATS score (${d.atsType})`} compareTo={d.kept === 'tailored' ? d.comboAts : null} />}
      {d.candidates.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Library ranking ({d.candidates.length})</summary>
          <table className="mt-1 w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal">Resume</th>
                <th className="text-right font-normal">Score</th>
                <th className="text-right font-normal">ATS</th>
                <th className="text-right font-normal">Similarity</th>
                <th className="text-right font-normal">Benchmark</th>
              </tr>
            </thead>
            <tbody>
              {d.candidates.map((c) => (
                <tr key={c.variantId} className={c.variantId === d.comboVariantId ? 'font-medium' : 'text-muted-foreground'}>
                  <td>{c.variantId === d.comboVariantId ? '★ ' : ''}{c.label ?? c.variantId.slice(0, 8)}</td>
                  <td className="text-right">{c.score}</td>
                  <td className="text-right">{c.ats}</td>
                  <td className="text-right">{c.similarity ?? '–'}</td>
                  <td className="text-right">{c.benchmark ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

/** Only shown when the fit loop changed something. */
export function fitLabel(f: NonNullable<ResumeVariant['fit']>): string {
  const parts: string[] = [];
  if (f.fontPt !== 10 || f.linespread !== 1) parts.push(`fit ${f.fontPt}pt × ${f.linespread}`);
  if (f.shortenedBullets.length) parts.push(`${f.shortenedBullets.length} shortened`);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function VariantCard({ variant: v }: { variant: ResumeVariant }) {
  const blocks = v.bullets.selectedBlockIds ?? [];
  const rewrites = v.header.rewrites ?? [];
  const reverted = v.validationReport.filter((r) => r.reverted).length;
  const warnings = v.validationReport.filter((r) => r.status === 'warning').length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className={STATUS_STYLE[v.status]}>{v.status.replace('_', ' ')}</Badge>
        <span className="text-muted-foreground">
          {blocks.length} block{blocks.length === 1 ? '' : 's'}
          {rewrites.length > 0 && ` · ${rewrites.length} rewrite${rewrites.length === 1 ? '' : 's'}`}
          {reverted > 0 && ` · ${reverted} reverted`}
          {warnings > 0 && ` · ${warnings} warning${warnings === 1 ? '' : 's'}`}
          {v.bullets.pages != null && ` · ${v.bullets.pages}pp`}
          {v.fit && fitLabel(v.fit)}
        </span>
        {v.provider && (
          <span className="text-muted-foreground">
            · {v.provider}/{v.model}
          </span>
        )}
        <span className="text-muted-foreground">· {relativeDate(v.createdAt)}</span>
        {v.pdfPath && (
          <a
            href={`/api/resume-variants/${v.id}/pdf`}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 text-xs underline"
          >
            <FileText className="h-3.5 w-3.5" />
            Open PDF ({Math.round((v.pdfBytes ?? 0) / 1024)} KB)
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {v.error && <p className="text-xs text-red-600">{v.error}</p>}
      {v.pdfPath && (
        <iframe
          src={`/api/resume-variants/${v.id}/pdf#view=FitH&toolbar=0`}
          title={`Tailored resume ${v.id.slice(0, 8)}`}
          className="h-96 w-full rounded-md border border-border bg-white"
        />
      )}
      {v.header.rationale && (
        <p className="text-sm italic text-muted-foreground">{v.header.rationale}</p>
      )}
      {blocks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {blocks.map((id) => (
            <Badge key={id} variant="outline">
              {id}
            </Badge>
          ))}
        </div>
      )}
      {rewrites.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Bullet rewrites ({rewrites.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {rewrites.map((r) => (
              <li key={r.bullet_id} className="rounded-md border border-border p-2">
                <div className="text-muted-foreground">[{r.bullet_id}] {r.reason}</div>
                <div className="mt-1 text-xs line-through opacity-70">{r.original}</div>
                <div className="text-xs">{r.rewritten}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {v.validationReport.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Guardrail report ({v.validationReport.length} rewrite{v.validationReport.length === 1 ? '' : 's'})
          </summary>
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {v.validationReport.map((r, i) => (
              <li key={`${r.bullet_id}-${i}`} className={ISSUE_STYLE[r.status]}>
                <div>
                  <span className="font-semibold uppercase">{r.status}</span>
                  {r.reverted && ' · reverted'} · [{r.bullet_id}]
                </div>
                <div className="opacity-70">{r.rewritten}</div>
                {r.issues.length > 0 && (
                  <ul className="list-disc pl-5">
                    {r.issues.map((is, j) => (
                      <li key={j}>
                        {is.kind}: {is.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
