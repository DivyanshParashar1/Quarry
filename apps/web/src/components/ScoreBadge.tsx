import { cn } from '@/lib/utils';
import { scoreTone } from '@/lib/filters';
import type { MatchMethod } from '@/lib/api';

const TONE = {
  good: 'bg-good text-white',
  ok: 'bg-ok text-black',
  weak: 'bg-weak text-white',
  none: 'bg-muted text-muted-foreground',
} as const;

export function ScoreBadge({ score, method, className }: { score: number | null; method: MatchMethod | null; className?: string }) {
  const label = method === 'llm' ? String(score) : method === 'filtered' ? '✕' : method === 'prefilter' ? '·' : '–';
  const title =
    method === 'llm' ? `Match score ${score}/100` : method === 'filtered' ? 'Failed a hard filter' : method === 'prefilter' ? 'Below the similarity prefilter' : 'Not scored yet';
  return (
    <span
      title={title}
      className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold tabular-nums', TONE[scoreTone(score, method)], className)}
    >
      {label}
    </span>
  );
}
