import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";

export type SearchScope = "all" | "wiki" | "raw" | "crystals";

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
  sources: Array<{ source: string; rank: number }>;
  provenance: {
    path: string;
    kind: "wiki" | "raw" | "crystal";
    dominantSource: string;
    signals: Array<{ source: string; rank: number }>;
  };
  kind: "wiki" | "raw" | "crystal";
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  warnings: string[];
  timings: {
    corpusMs: number;
    embedQueryMs: number;
    bm25Ms: number;
    vectorMs: number;
    graphMs: number;
    graphSpreadMs: number;
    rerankMs: number;
    totalMs: number;
  };
  degraded: boolean;
  hyde: { used: boolean; reason: string };
  corpusErrorCount: number;
}

export interface UseSearchOptions {
  query: string;
  scope?: SearchScope;
  k?: number;
  noRerank?: boolean;
  enabled?: boolean;
}

export function useSearch({
  query,
  scope = "all",
  k = 10,
  noRerank = false,
  enabled = true,
}: UseSearchOptions) {
  return useQuery({
    queryKey: ["search", query, scope, k, noRerank],
    queryFn: () =>
      apiGet<SearchResponse>("/search", {
        q: query,
        scope,
        k,
        noRerank: noRerank ? "true" : undefined,
      }),
    enabled: enabled && query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
