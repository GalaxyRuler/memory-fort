import { cn } from "../lib/cn.js";
import { formatSearchSourceLabel, normalizeSearchSignals, searchSourceColorClass } from "../lib/search-sources.js";

export interface ScoreBreakdownProps {
  sources: Array<{ source: string; rank: number }>;
  className?: string;
}

export function ScoreBreakdown({ sources, className }: ScoreBreakdownProps) {
  const normalizedSources = normalizeSearchSignals(sources);
  const contributions = normalizedSources.map((source) => ({
    source: source.source,
    weight: 1 / (60 + source.rank),
  }));
  const totalWeight = contributions.reduce((sum, contribution) => {
    return sum + contribution.weight;
  }, 0) || 1;
  const segments = contributions.map((contribution) => ({
    source: contribution.source,
    pct: (contribution.weight / totalWeight) * 100,
  }));

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div
        className="flex h-1 overflow-hidden rounded-full bg-surface-2"
        data-testid="score-breakdown-bar"
      >
        {segments.map((segment, index) => {
          const label = formatSearchSourceLabel(segment.source);
          return (
            <span
              key={`${segment.source}-${index}`}
              aria-label={`${label}: ${segment.pct.toFixed(0)}%`}
              className={searchSourceColorClass(segment.source)}
              style={{ width: `${segment.pct}%` }}
              title={`${label}: ${segment.pct.toFixed(0)}%`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-muted">
        {segments.map((segment, index) => {
          const label = formatSearchSourceLabel(segment.source);
          return (
            <span key={`${segment.source}-${index}`} className="flex max-w-full items-center gap-1 break-all">
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 flex-shrink-0 rounded-full", searchSourceColorClass(segment.source))}
              />
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
