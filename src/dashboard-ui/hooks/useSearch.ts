import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";
import { normalizeSearchSignals } from "../lib/search-sources.js";

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

type RuntimeSearchResult = Omit<SearchResult, "provenance" | "sources"> & {
  sources?: unknown;
  provenance?: {
    path?: unknown;
    kind?: unknown;
    dominantSource?: unknown;
    signals?: unknown;
  };
};

type RuntimeSearchResponse = Omit<SearchResponse, "results"> & {
  results?: RuntimeSearchResult[];
};

export function useSearch({
  query,
  scope = "all",
  k = 10,
  noRerank = false,
  enabled = true,
}: UseSearchOptions) {
  return useQuery({
    queryKey: ["search", query, scope, k, noRerank],
    queryFn: async () => {
      const response = await apiGet<RuntimeSearchResponse>("/search", {
        q: query,
        scope,
        k,
        noRerank: noRerank ? "true" : undefined,
      });
      return normalizeSearchResponse(response);
    },
    enabled: enabled && query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

function normalizeSearchResponse(response: RuntimeSearchResponse): SearchResponse {
  return {
    ...response,
    results: Array.isArray(response.results) ? response.results.map(normalizeSearchResult) : [],
  };
}

function normalizeSearchResult(result: RuntimeSearchResult): SearchResult {
  const provenance = result.provenance;
  return {
    ...result,
    sources: normalizeSearchSignals(result.sources),
    provenance: {
      path: typeof provenance?.path === "string" ? provenance.path : result.path,
      kind: isSearchResultKind(provenance?.kind) ? provenance.kind : result.kind,
      dominantSource: typeof provenance?.dominantSource === "string" ? provenance.dominantSource : result.source,
      signals: normalizeSearchSignals(provenance?.signals),
    },
  };
}

function isSearchResultKind(kind: unknown): kind is SearchResult["kind"] {
  return kind === "wiki" || kind === "raw" || kind === "crystal";
}
