import type { Stats } from '@/lib/api';

export function StatsBar({ stats }: { stats: Stats | undefined }) {
  if (!stats) return null;
  const m = stats.match;
  const items: [string, string][] = [
    ['open jobs', m.openJobs.toLocaleString()],
    ['LLM-scored', m.scored.llm.toLocaleString()],
    ['excluded', (m.scored.filtered + m.scored.prefilter).toLocaleString()],
    ['unscored', m.unscored.toLocaleString()],
    ['LLM 24h', `${stats.llm24h.calls} calls · $${stats.llm24h.costUsd.toFixed(2)}`],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="font-medium text-foreground tabular-nums">{v}</span> {k}
        </span>
      ))}
      {stats.profile && (
        <span title={`Profile version ${stats.profile.version}`}>
          profile <span className="font-mono text-foreground">{stats.profile.version.slice(0, 8)}</span>
        </span>
      )}
    </div>
  );
}
