import { Badge } from '@/components/ui/badge';
import type { AtsScore } from '@/lib/api';
import { cn } from '@/lib/utils';

export function scoreTone(score: number): string {
  return score >= 80 ? 'bg-good text-black' : score >= 60 ? 'bg-ok text-black' : 'bg-weak text-black';
}

const CHECK_LABEL: Record<string, string> = {
  extractable: 'Text extractable',
  encoding: 'No broken glyphs',
  spacing: 'Word spacing',
  sections: 'Standard sections',
  contact: 'Contact parsed',
  dates: 'Dates parseable',
  reading_order: 'Reading order',
  columns: 'No column run-ins',
};

/** Phase 16: deterministic ATS score for one resume against one job. */
export function AtsScoreCard({ ats, title, compareTo }: { ats: AtsScore; title?: string; compareTo?: AtsScore | null }) {
  const delta = compareTo ? ats.score - compareTo.score : null;
  const { matched, missing, hardMissing, coverage } = ats.keywords;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{title ?? 'ATS score'}</span>
        <Badge className={scoreTone(ats.score)}>{ats.score}</Badge>
        <span className="text-muted-foreground">
          {ats.atsType} · parse {ats.parse.score}
          {coverage !== null && ` · keywords ${coverage}%`}
        </span>
        {delta !== null && delta !== 0 && (
          <span className={cn('font-medium', delta > 0 ? 'text-green-700' : 'text-red-600')}>
            {delta > 0 ? '+' : ''}
            {delta} vs combo
          </span>
        )}
      </div>
      {hardMissing.length > 0 && (
        <p className="text-red-600">Missing hard requirements: {hardMissing.join(', ')}</p>
      )}
      {(matched.length > 0 || missing.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {matched.map((k) => (
            <Badge key={`m-${k}`} variant="outline" className="border-green-600 text-green-700">
              {k}
            </Badge>
          ))}
          {missing.map((k) => (
            <Badge key={`x-${k}`} variant="outline" className={cn(hardMissing.includes(k) ? 'border-red-600 text-red-600' : 'text-muted-foreground')}>
              {k}
            </Badge>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">Parse checks</summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {ats.parse.checks.map((c) => (
            <li key={c.id} className={c.pass ? 'text-muted-foreground' : 'text-red-600'}>
              {c.pass ? '✓' : '✗'} {CHECK_LABEL[c.id] ?? c.id} — {c.detail}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
