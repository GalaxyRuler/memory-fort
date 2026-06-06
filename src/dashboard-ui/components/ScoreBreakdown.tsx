import { cn } from "../lib/cn.js";

export interface ScoreBreakdownProps {
  sources: Array<{ source: string; rank: number }>;
  className?: string;
}

const SOURCE_COLORS: Record<string, string> = {
  bm25: "bg-status-blue",
  vector: "bg-entity-decisions",
  exact: "bg-status-green",
  graph: "bg-entity-references",
  "graph-spread": "bg-entity-tools",
  metadata: "bg-text-muted",
  rerank: "bg-entity-crystals",
};

const SOURCE_LABELS: Record<string, string> = {
  bm25: "BM25",
  vector: "embed",
  exact: "exact",
  graph: "graph",
  "graph-spread": "graph spread",
  metadata: "meta",
  rerank: "rerank",
};

export function ScoreBreakdown({ sources, className }: ScoreBreakdownProps) {
  const contributions = sources.map((source) => ({
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
        {segments.map((segment) => {
          const label = SOURCE_LABELS[segment.source] ?? segment.source;
          return (
            <span
              key={segment.source}
              aria-label={`${label}: ${segment.pct.toFixed(0)}%`}
              className={SOURCE_COLORS[segment.source] ?? "bg-text-muted"}
              style={{ width: `${segment.pct}%` }}
              title={`${label}: ${segment.pct.toFixed(0)}%`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px] text-text-muted">
        {segments.map((segment) => {
          const label = SOURCE_LABELS[segment.source] ?? segment.source;
          return (
            <span key={segment.source} className="flex items-center gap-1">
              <span
                aria-hidden
                className={cn("h-1.5 w-1.5 rounded-full", SOURCE_COLORS[segment.source] ?? "bg-text-muted")}
              />
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
