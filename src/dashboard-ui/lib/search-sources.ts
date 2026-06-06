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
const MAX_UNKNOWN_SOURCE_LABEL_LENGTH = 32;

export interface SearchSignal {
  source: string;
  rank: number;
}

export function formatSearchSourceLabel(source: string): string {
  const knownLabel = SEARCH_SOURCE_LABELS[source];
  if (knownLabel) return knownLabel;

  const sanitized = source.replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) return "unknown";
  if (sanitized.length <= MAX_UNKNOWN_SOURCE_LABEL_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_UNKNOWN_SOURCE_LABEL_LENGTH)}...`;
}

export function searchSourceColorClass(source: string): string {
  return SEARCH_SOURCE_COLORS[source] ?? "bg-text-muted";
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
