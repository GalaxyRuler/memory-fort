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

export function formatSearchSourceLabel(source: string): string {
  return SEARCH_SOURCE_LABELS[source] ?? source;
}

export function searchSourceColorClass(source: string): string {
  return SEARCH_SOURCE_COLORS[source] ?? "bg-text-muted";
}
