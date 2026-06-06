const SEARCH_SOURCE_LABELS: Record<string, string> = {
  bm25: "BM25",
  vector: "embed",
  exact: "exact",
  graph: "graph",
  "graph-spread": "graph spread",
  metadata: "meta",
  rerank: "rerank",
};

const SEARCH_SOURCE_COLORS: Record<string, string> = {
  bm25: "bg-status-blue",
  vector: "bg-entity-decisions",
  exact: "bg-status-green",
  graph: "bg-entity-references",
  "graph-spread": "bg-entity-tools",
  metadata: "bg-text-muted",
  rerank: "bg-entity-crystals",
};

export const KNOWN_SEARCH_SOURCES = Object.keys(SEARCH_SOURCE_LABELS);

export interface SearchSignal {
  source: string;
  rank: number;
}

export function formatSearchSourceLabel(source: string): string {
  return SEARCH_SOURCE_LABELS[source] ?? source;
}

export function searchSourceColorClass(source: string): string {
  return SEARCH_SOURCE_COLORS[source] ?? "bg-text-muted";
}

export function isValidSearchRank(rank: unknown): boolean {
  return parseSearchRank(rank) !== null;
}

export function normalizeSearchSignals(signals: unknown): SearchSignal[] {
  if (!Array.isArray(signals)) return [];

  return signals.flatMap((signal) => {
    if (!signal || typeof signal !== "object") return [];
    const source = "source" in signal ? signal.source : undefined;
    const rank = "rank" in signal ? parseSearchRank(signal.rank) : null;

    if (typeof source !== "string" || rank === null) return [];

    const normalizedSource = source.trim();
    if (normalizedSource.length === 0) return [];

    return [{ source: normalizedSource, rank }];
  });
}

function parseSearchRank(rank: unknown): number | null {
  if (typeof rank === "number") {
    return Number.isSafeInteger(rank) && rank > 0 ? rank : null;
  }

  if (typeof rank === "string") {
    const trimmed = rank.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}
