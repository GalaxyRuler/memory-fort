import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api.js";
import { parseSearchCapabilities, type SearchCapabilities as SharedSearchCapabilities } from "../../search/contract.js";
import { normalizeSearchSignals } from "../lib/search-sources.js";

export type SearchScope = "all" | "wiki" | "raw" | "crystals";

export type SearchCapabilities = SharedSearchCapabilities;

export interface SearchProvenance {
  path: string;
  kind: "wiki" | "raw" | "crystal";
  dominantSource: string;
  signals: Array<{ source: string; rank: number }>;
  confidence: number | null;
  confidenceMetadata?: unknown;
  validation?: string | null;
  sourceFactCount: number | null;
  derivedFromCount: number | null;
  tier: "high" | "medium" | "low" | null;
  chunkId?: string | null;
  chunkOrdinal?: number | null;
  byteStart?: number | null;
  byteEnd?: number | null;
  sourceContentHash?: string | null;
  chunkTextHash?: string | null;
  indexGeneration?: number | null;
  indexedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  observedAt?: string | null;
  lexicalRank?: number | null;
  lexicalScore?: number | null;
  vectorRank?: number | null;
  vectorDistance?: number | null;
  appliedScope?: SearchScope | null;
  appliedFilters?: {
    includeArchived: boolean | null;
    asOf: string | null;
    agentId: string | null;
    userId: string | null;
    identityMode: "inclusive" | "strict" | null;
  } | null;
  backend?: "legacy" | "index-lexical" | "index-hybrid" | null;
  rankingProfile?: string | null;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
  sources: Array<{ source: string; rank: number }>;
  provenance: SearchProvenance;
  kind: "wiki" | "raw" | "crystal";
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  warnings: string[];
  index?: SearchIndexStatus;
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
  /** Active retrieval backend (index-lexical / index-hybrid / legacy). */
  searchBackend?: string;
  /** Params present in the request but not applied by the active backend. */
  ignoredParams?: string[];
}

export interface SearchIndexStatus {
  enabled: boolean;
  dbPath: string;
  sizeBytes?: number;
  schemaVersion: string | null;
  chunkCount: number;
  filesSkipped: number;
  skippedFiles: Array<{
    relPath: string;
    errorState: string;
    sizeBytes: number | null;
  }>;
  lastCompleteReconcile: string | null;
  currentState: string;
  lastError: string | null;
  ready: boolean;
}

export interface UseSearchOptions {
  query: string;
  scope?: SearchScope;
  k?: number;
  noRerank?: boolean;
  includeArchived?: boolean;
  enabled?: boolean;
}

type RuntimeSearchResult = Partial<Omit<SearchResult, "provenance" | "sources">> & {
  sources?: unknown;
  provenance?: {
    path?: unknown;
    kind?: unknown;
    dominantSource?: unknown;
    signals?: unknown;
    confidence?: unknown;
    sourceFactCount?: unknown;
    derivedFromCount?: unknown;
    tier?: unknown;
    confidenceMetadata?: unknown;
    validation?: unknown;
    chunkId?: unknown;
    chunkOrdinal?: unknown;
    byteStart?: unknown;
    byteEnd?: unknown;
    sourceContentHash?: unknown;
    chunkTextHash?: unknown;
    indexGeneration?: unknown;
    indexedAt?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    observedAt?: unknown;
    lexicalRank?: unknown;
    lexicalScore?: unknown;
    vectorRank?: unknown;
    vectorDistance?: unknown;
    appliedScope?: unknown;
    appliedFilters?: unknown;
    backend?: unknown;
    rankingProfile?: unknown;
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
  includeArchived = false,
  enabled = true,
}: UseSearchOptions) {
  return useQuery({
    queryKey: ["search", query, scope, k, noRerank, includeArchived],
    queryFn: async () => {
      const response = await apiGet<RuntimeSearchResponse>("/search", {
        q: query,
        scope,
        k,
        noRerank: noRerank ? "true" : undefined,
        includeArchived: includeArchived ? "1" : undefined,
      });
      return normalizeSearchResponse(response);
    },
    enabled: enabled && query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useSearchCapabilities() {
  return useQuery({
    queryKey: ["search-capabilities"],
    queryFn: async () => parseSearchCapabilities(await apiGet<unknown>("/search/capabilities")),
    staleTime: 30_000,
  });
}

function normalizeSearchResponse(response: RuntimeSearchResponse): SearchResponse {
  return {
    ...response,
    results: Array.isArray(response.results) ? response.results.flatMap(normalizeSearchResult) : [],
  };
}

export function normalizeSearchResult(result: RuntimeSearchResult): SearchResult[] {
  if (typeof result.path !== "string" || !isSearchResultKind(result.kind)) return [];

  const provenance = result.provenance;
  const source = typeof result.source === "string" ? result.source : "";
  const normalizedResult: SearchResult = {
    ...result,
    path: result.path,
    title: typeof result.title === "string" ? result.title : "",
    snippet: typeof result.snippet === "string" ? result.snippet : "",
    score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : 0,
    source,
    sources: normalizeSearchSignals(result.sources),
    kind: result.kind,
    provenance: {
      path: typeof provenance?.path === "string" ? provenance.path : result.path,
      kind: isSearchResultKind(provenance?.kind) ? provenance.kind : result.kind,
      dominantSource: typeof provenance?.dominantSource === "string" ? provenance.dominantSource : source,
      signals: normalizeSearchSignals(provenance?.signals),
      confidence: normalizeProvenanceProbability(provenance?.confidence),
      sourceFactCount: normalizeProvenanceCount(provenance?.sourceFactCount),
      derivedFromCount: normalizeProvenanceCount(provenance?.derivedFromCount),
      tier: normalizeProvenanceTier(provenance?.tier),
      confidenceMetadata: provenance?.confidenceMetadata,
      validation: normalizeNullableString(provenance?.validation),
      chunkId: normalizeNullableNonEmptyString(provenance?.chunkId),
      chunkOrdinal: normalizeProvenanceCount(provenance?.chunkOrdinal),
      byteStart: normalizeProvenanceCount(provenance?.byteStart),
      byteEnd: normalizeProvenanceCount(provenance?.byteEnd),
      sourceContentHash: normalizeNullableHash(provenance?.sourceContentHash),
      chunkTextHash: normalizeNullableHash(provenance?.chunkTextHash),
      indexGeneration: normalizeProvenanceCount(provenance?.indexGeneration),
      indexedAt: normalizeNullableString(provenance?.indexedAt),
      createdAt: normalizeNullableString(provenance?.createdAt),
      updatedAt: normalizeNullableString(provenance?.updatedAt),
      observedAt: normalizeNullableString(provenance?.observedAt),
      lexicalRank: normalizeProvenanceCount(provenance?.lexicalRank),
      lexicalScore: normalizeNullableFiniteNumber(provenance?.lexicalScore),
      vectorRank: normalizeProvenanceCount(provenance?.vectorRank),
      vectorDistance: normalizeNullableFiniteNumber(provenance?.vectorDistance),
      appliedScope: normalizeProvenanceScope(provenance?.appliedScope),
      appliedFilters: normalizeAppliedFilters(provenance?.appliedFilters),
      backend: normalizeProvenanceBackend(provenance?.backend),
      rankingProfile: normalizeNullableString(provenance?.rankingProfile),
    },
  };
  return [normalizedResult];
}

function isSearchResultKind(kind: unknown): kind is SearchResult["kind"] {
  return kind === "wiki" || kind === "raw" || kind === "crystal";
}

function normalizeProvenanceProbability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
function normalizeProvenanceCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function normalizeProvenanceTier(value: unknown): "high" | "medium" | "low" | null {
  return value === "high" || value === "medium" || value === "low" ? value : null;
}
function normalizeNullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function normalizeNullableNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function normalizeNullableHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value : null;
}
function normalizeProvenanceScope(value: unknown): SearchScope | null {
  return value === "all" || value === "wiki" || value === "raw" || value === "crystals" ? value : null;
}
function normalizeProvenanceBackend(value: unknown): SearchProvenance["backend"] {
  return value === "legacy" || value === "index-lexical" || value === "index-hybrid" ? value : null;
}
function normalizeAppliedFilters(value: unknown): SearchProvenance["appliedFilters"] {
  if (!isRecord(value)) return null;
  return {
    includeArchived: typeof value["includeArchived"] === "boolean" ? value["includeArchived"] : null,
    asOf: normalizeNullableString(value["asOf"]),
    agentId: normalizeNullableString(value["agentId"]),
    userId: normalizeNullableString(value["userId"]),
    identityMode: normalizeIdentityMode(value["identityMode"]),
  };
}
function normalizeIdentityMode(value: unknown): "inclusive" | "strict" | null {
  return value === "inclusive" || value === "strict" ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
