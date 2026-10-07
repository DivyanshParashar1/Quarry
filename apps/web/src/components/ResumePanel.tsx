import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { getJson, send, type ResumeVariant } from '@/lib/api';
import { relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<ResumeVariant['status'], string> = {
  rendered: 'bg-good text-black',
  validation_failed: 'bg-weak text-black',
  render_failed: 'bg-ok text-black',
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
    queryFn: () => getJson<{ variants: ResumeVariant[] }>(`/api/jobs/${jobId}/resume-variants`),
  });
  const tailor = useMutation({
    mutationFn: () => send<ResumeVariant>(`/api/jobs/${jobId}/tailor`, 'POST'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resume-variants', jobId] });
      void qc.invalidateQueries({ queryKey: ['job-outreach', jobId] });
    },
  });

  const variants = q.data?.variants ?? [];
  const latest = variants[0];

  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Tailored resume</h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => tailor.mutate()}
          disabled={tailor.isPending}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', tailor.isPending && 'animate-spin')} />
          {variants.length ? 'Retailor' : 'Tailor for this job'}
        </Button>
      </div>
      {tailor.isPending && <p className="text-sm text-muted-foreground">Assembling blocks and compiling with latexmk…</p>}
      {tailor.error && <p className="text-sm text-red-600">{(tailor.error as Error).message}</p>}
      {!latest && !tailor.isPending && (
        <p className="text-sm text-muted-foreground">
          No tailored resume yet. The tailor picks which blocks from profile/resume/ to include and renders a one-page PDF; any bullet rewrites are checked against the original.
        </p>
      )}
      {latest && <VariantCard variant={latest} />}
      {variants.length > 1 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {variants.length - 1} older variant(s)
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {variants.slice(1).map((v) => (
              <li key={v.id} className="text-xs text-muted-foreground">
                <Badge className={STATUS_STYLE[v.status]}>{v.status.replace('_', ' ')}</Badge>{' '}
                {relativeDate(v.createdAt)}
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
