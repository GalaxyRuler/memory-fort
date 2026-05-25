import { loadSearchCorpus, type SearchDocument, type SearchScope } from "./corpus.js";
import { loadEmbeddings, type EmbeddingKind } from "./embeddings-store.js";
import {
  buildBm25IndexFromEntries,
  scoreBm25,
  tokenize,
  type Bm25Index,
  type Bm25IndexEntry,
  type Tokens,
} from "./bm25.js";
import { exactBoosts } from "./exact.js";
import { buildGraph, expandGraph, spreadingActivation } from "./graph.js";
import { scoreByMetadata } from "./metadata-score.js";
import { rrfFuse, type RankedItem, type RrfResult } from "./rrf.js";
import { rerankCandidates } from "./rerank.js";
import {
  applyHydeExpansion,
  buildHydePrompt,
  defaultSchemaSummary,
  shouldUseHyde,
} from "./hyde.js";
import { refreshEmbeddings, type EmbedClient } from "./refresh.js";
import type { VoyageClient } from "./voyage-client.js";

export interface SearchOptions {
  query: string;
  scope?: SearchScope;
  k?: number;
  minScore?: number;
  noRerank?: boolean;
  noHyde?: boolean;
  hydeExpansion?: string;
  signal?: AbortSignal;
  vaultRoot: string;
  embedClient: EmbedClient;
  voyageClient: VoyageClient;
  corpusLoader?: () => Promise<{
    documents: SearchDocument[];
    errors: Array<{ path: string; reason: string }>;
  }>;
  now?: () => Date;
}

export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  source: string;
  sources: Array<{ source: string; rank: number }>;
  kind: "wiki" | "raw" | "crystal";
}

export interface SearchTimings {
  corpusMs: number;
  refreshMs: number;
  embedQueryMs: number;
  bm25Ms: number;
  vectorMs: number;
  exactMs: number;
  graphMs: number;
  graphSpreadMs: number;
  metadataMs: number;
  rrfMs: number;
  rerankMs: number;
  totalMs: number;
}

export interface HydeStatus {
  used: boolean;
  reason:
    | "not-triggered"
    | "disabled-by-flag"
    | "triggered-pending-expansion"
    | "applied";
  promptEmitted?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  warnings: string[];
  timings: SearchTimings;
  degraded: boolean;
  hyde: HydeStatus;
  corpusErrorCount: number;
}

type QueryEmbedClient = {
  embed(
    texts: string[],
    opts?: { inputType?: "document" | "query"; signal?: AbortSignal },
  ): Promise<{ vectors: number[][]; model: string; dim: number }>;
};

interface VectorScore {
  relPath: string;
  score: number;
}

interface Candidate {
  rrf: RrfResult;
  document: SearchDocument;
}

const DEFAULT_K = 10;
const DEFAULT_MIN_SCORE = 0;
const SIGNAL_LIMIT = 50;
const BM25_CACHE_MAX_ENTRIES = 8;
const BM25_TOKEN_CACHE_MAX_ENTRIES = 4096;
// Voyage returns low positive cosine for unrelated text; keep vector as a signal, not a universal match.
const MIN_VECTOR_SCORE = 0.25;
const LEXICAL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "no",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);
const HYDE_PROMPT_TEMPLATE = `# HyDE expansion prompt

You're helping the memory system search for information. A short or abstract query has been provided. Write a SHORT hypothetical paragraph (100-300 tokens) that reads as if it were a perfect curated wiki entry answering the query. The paragraph will be embedded and used to find semantically similar wiki/raw content.

## Query

{{query}}

## Schema reminder (memory entity types)

{{schema_summary}}

## Instructions

- Write 1-3 paragraphs in plain prose, as if explaining the topic to a colleague
- Use concrete domain terms the wiki would use (project names, tool names, concepts)
- Don't include meta-commentary, fences, or headings -- just paragraphs of body text
- Don't hedge with "I don't know" -- invent plausible content; this is for semantic embedding only, not factual response
- Aim for ~150-200 words

Now write the hypothetical paragraph(s):`;

const bm25IndexCache = new Map<string, Bm25Index>();
const bm25TokenCache = new Map<string, Bm25IndexEntry>();

export async function runSearch(opts: SearchOptions): Promise<SearchResponse> {
  if (!opts.vaultRoot) throw new Error("vaultRoot is required");
  if (!opts.embedClient) throw new Error("embedClient is required");
  if (!opts.voyageClient) throw new Error("voyageClient is required");
  throwIfAborted(opts.signal);

  const started = Date.now();
  const timings = emptyTimings();
  const warnings: string[] = [];
  let degraded = false;
  const scope = opts.scope ?? "all";
  const resultLimit = Math.max(0, Math.floor(opts.k ?? DEFAULT_K));
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  const corpusStarted = Date.now();
  const loaded = opts.corpusLoader
    ? await opts.corpusLoader()
    : await loadSearchCorpus({ vaultRoot: opts.vaultRoot, scope });
  timings.corpusMs = Date.now() - corpusStarted;
  throwIfAborted(opts.signal);

  const corpusErrors = loaded.errors ?? [];
  if (corpusErrors.length > 0) {
    degraded = true;
    warnings.push(
      ...corpusErrors.map((error) => `corpus ${error.path}: ${error.reason}`),
    );
  }

  const documents = filterByScope(loaded.documents, scope);
  if (documents.length === 0 || resultLimit === 0) {
    timings.totalMs = Date.now() - started;
    return {
      query: opts.query,
      results: [],
      warnings,
      timings,
      degraded,
      hyde: { used: false, reason: "not-triggered" },
      corpusErrorCount: corpusErrors.length,
    };
  }

  const hyde = hydeStatus(opts);
  const embeddingInput =
    opts.hydeExpansion !== undefined
      ? applyHydeExpansion({
          query: opts.query,
          expansion: opts.hydeExpansion,
        }).embeddingInput
      : opts.query;
  const lexicalQuery = lexicalSignalQuery(opts.query);

  const refreshStarted = Date.now();
  try {
    const refresh = await refreshEmbeddings({
      memoryRoot: opts.vaultRoot,
      documents,
      embedClient: opts.embedClient,
      now: opts.now,
    });
    if (refresh.errors.length > 0) {
      degraded = true;
      warnings.push(
        ...refresh.errors.map((error) => `embedding refresh ${error.path}: ${error.reason}`),
      );
    }
  } catch (error) {
    throwIfAborted(opts.signal);
    degraded = true;
    warnings.push(`embedding refresh failed: ${errorMessage(error)}`);
  }
  timings.refreshMs = Date.now() - refreshStarted;
  throwIfAborted(opts.signal);

  let queryVector: number[] | null = null;
  const embedStarted = Date.now();
  try {
    const response = await (opts.embedClient as QueryEmbedClient).embed(
      [embeddingInput],
      { inputType: "query", signal: opts.signal },
    );
    queryVector = response.vectors[0] ?? null;
    if (!queryVector) {
      degraded = true;
      warnings.push("query embedding failed: embed response contained no vector");
    }
  } catch (error) {
    throwIfAborted(opts.signal);
    degraded = true;
    warnings.push(`query embedding failed: ${errorMessage(error)}`);
  }
  timings.embedQueryMs = Date.now() - embedStarted;
  throwIfAborted(opts.signal);

  const bm25Started = Date.now();
  const bm25 = scoreBm25(
    lexicalQuery,
    cachedBm25Index(opts.vaultRoot, documents),
  ).slice(0, SIGNAL_LIMIT);
  timings.bm25Ms = Date.now() - bm25Started;

  const vectorStarted = Date.now();
  const vector = queryVector
    ? await vectorScores(opts.vaultRoot, documents, queryVector, warnings)
    : [];
  if (warnings.some((warning) => warning.startsWith("embeddings "))) {
    degraded = true;
  }
  timings.vectorMs = Date.now() - vectorStarted;

  const exactStarted = Date.now();
  const exact = exactBoosts(
    lexicalQuery,
    documents.map((document) => ({
      relPath: document.relPath,
      title: document.title,
      tags: document.tags,
    })),
  );
  timings.exactMs = Date.now() - exactStarted;

  const graphStarted = Date.now();
  const graph = buildGraph(documents);
  const seed = new Set([
    ...bm25.slice(0, 3).map((score) => score.relPath),
    ...vector.slice(0, 3).map((score) => score.relPath),
  ]);
  const graphRanked = [...expandGraph(seed, graph, { hops: 1 }).expanded].map(
    (relPath, index): RankedItem => ({ relPath, rank: index + 1 }),
  );
  timings.graphMs = Date.now() - graphStarted;

  const graphSpreadStarted = Date.now();
  const graphSpreadRanked = spreadingActivationEnabled()
    ? spreadingActivation(seed, graph).map(
        (item, index): RankedItem => ({
          relPath: item.path,
          rank: index + 1,
        }),
      )
    : [];
  timings.graphSpreadMs = Date.now() - graphSpreadStarted;

  const metadataStarted = Date.now();
  const metadata = scoreByMetadata(documents, {
    now: opts.now?.(),
  });
  timings.metadataMs = Date.now() - metadataStarted;

  const rrfStarted = Date.now();
  const fused = rrfFuse([
    { source: "bm25", items: toRankedItems(bm25) },
    { source: "vector", items: toRankedItems(vector) },
    { source: "exact", items: toRankedItems(exact) },
    { source: "graph", items: graphRanked },
    { source: "graph-spread", items: graphSpreadRanked },
    {
      source: "metadata",
      items: metadata.map((score, index) => ({
        relPath: score.path,
        rank: index + 1,
      })),
    },
  ]);
  const fusedFiltered = fused.filter((item) =>
    item.sources.some((source) => source.source !== "metadata"),
  );
  timings.rrfMs = Date.now() - rrfStarted;

  const byPath = new Map(documents.map((document) => [document.relPath, document]));
  const candidateLimit = Math.min(SIGNAL_LIMIT, Math.max(resultLimit * 2, resultLimit));
  const candidates: Candidate[] = fusedFiltered
    .slice(0, candidateLimit)
    .map((rrf) => {
      const document = byPath.get(rrf.relPath);
      return document ? { rrf, document } : null;
    })
    .filter((candidate): candidate is Candidate => candidate !== null);

  const rerankStarted = Date.now();
  let final = candidates.map((candidate) => ({
    candidate,
    score: candidate.rrf.score,
    source: dominantSource(candidate.rrf),
  }));
  if (!opts.noRerank && candidates.length > 0) {
    const reranked = await rerankCandidates({
      query: opts.query,
      candidates: candidates.map((candidate) => ({
        relPath: candidate.document.relPath,
        text: rerankText(candidate.document),
      })),
      voyageClient: opts.voyageClient,
      signal: opts.signal,
      topK: candidates.length,
    });
    throwIfAborted(opts.signal);
    if (reranked.degraded) {
      degraded = true;
      if (reranked.warning) warnings.push(reranked.warning);
    } else {
      const byOriginalIndex = new Map(
        candidates.map((candidate, index) => [index, candidate] as const),
      );
      final = reranked.ranked
        .map((item) => {
          const candidate = byOriginalIndex.get(item.originalIndex);
          return candidate
            ? { candidate, score: item.score, source: "rerank" }
            : null;
        })
        .filter((item): item is (typeof final)[number] => item !== null);
    }
    timings.rerankMs = reranked.latencyMs;
  } else {
    timings.rerankMs = Date.now() - rerankStarted;
  }

  const results = final
    .filter((item) => item.score >= minScore)
    .slice(0, resultLimit)
    .map(({ candidate, score, source }): SearchResult => ({
      path: candidate.document.relPath,
      title: candidate.document.title,
      snippet: candidate.document.snippetSource,
      score,
      source,
      sources: candidate.rrf.sources,
      kind: candidate.document.kind,
    }));

  timings.totalMs = Date.now() - started;
  return {
    query: opts.query,
    results,
    warnings,
    timings,
    degraded,
    hyde,
    corpusErrorCount: corpusErrors.length,
  };
}

function hydeStatus(opts: SearchOptions): HydeStatus {
  if (opts.noHyde) return { used: false, reason: "disabled-by-flag" };
  if (opts.hydeExpansion !== undefined) return { used: true, reason: "applied" };
  if (shouldUseHyde({ query: opts.query, bm25HitCount: 0 })) {
    return {
      used: false,
      reason: "triggered-pending-expansion",
      promptEmitted: buildHydePrompt({
        query: opts.query,
        templateContent: HYDE_PROMPT_TEMPLATE,
        schemaSummary: defaultSchemaSummary(),
      }),
    };
  }
  return { used: false, reason: "not-triggered" };
}

async function vectorScores(
  memoryRoot: string,
  documents: SearchDocument[],
  queryVector: number[],
  warnings: string[],
): Promise<VectorScore[]> {
  const recordsByPath = new Map<string, number[]>();
  for (const kind of documentKinds(documents)) {
    try {
      const loaded = await loadEmbeddings(memoryRoot, kind);
      for (const warning of loaded.warnings) {
        warnings.push(`embeddings ${kind}:${warning.line}: ${warning.reason}`);
      }
      for (const record of loaded.records) {
        recordsByPath.set(record.path, record.vector);
      }
    } catch (error) {
      warnings.push(`embeddings ${kind}: ${errorMessage(error)}`);
    }
  }

  return documents
    .map((document): VectorScore | null => {
      const vector = recordsByPath.get(document.relPath);
      if (!vector) return null;
      const score = cosineSimilarity(queryVector, vector);
      return score >= MIN_VECTOR_SCORE ? { relPath: document.relPath, score } : null;
    })
    .filter((score): score is VectorScore => score !== null)
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath))
    .slice(0, SIGNAL_LIMIT);
}

function documentKinds(documents: SearchDocument[]): EmbeddingKind[] {
  const kinds = new Set<EmbeddingKind>();
  for (const document of documents) kinds.add(document.kind);
  return [...kinds].sort();
}

function filterByScope(
  documents: SearchDocument[],
  scope: SearchScope,
): SearchDocument[] {
  if (scope === "all") return documents;
  if (scope === "crystals") {
    return documents.filter((document) => document.kind === "crystal");
  }
  return documents.filter((document) => document.kind === scope);
}

function toRankedItems(scores: Array<{ relPath: string }>): RankedItem[] {
  return scores.map((score, index) => ({ relPath: score.relPath, rank: index + 1 }));
}

function cachedBm25Index(vaultRoot: string, documents: SearchDocument[]): Bm25Index {
  const fingerprint = corpusFingerprint(vaultRoot, documents);
  const cached = bm25IndexCache.get(fingerprint);
  if (cached) return cached;

  const index = buildBm25IndexFromEntries(
    documents.map((document) => cachedTokenizedDocument(vaultRoot, document)),
  );
  bm25IndexCache.set(fingerprint, index);
  trimBm25Cache();
  return index;
}

function cachedTokenizedDocument(
  vaultRoot: string,
  document: SearchDocument,
): Bm25IndexEntry {
  const cacheKey = tokenCacheKey(vaultRoot, document);
  const cached = bm25TokenCache.get(cacheKey);
  if (cached) {
    bm25TokenCache.delete(cacheKey);
    bm25TokenCache.set(cacheKey, cached);
    return cached;
  }

  const entry = {
    relPath: document.relPath,
    tokens: buildTokens(document.body),
  };
  bm25TokenCache.set(cacheKey, entry);
  trimBm25TokenCache();
  return entry;
}

function buildTokens(text: string): Tokens {
  const terms = tokenize(text);
  const termCount = new Map<string, number>();
  for (const term of terms) {
    termCount.set(term, (termCount.get(term) ?? 0) + 1);
  }
  return { terms, termCount, length: terms.length };
}

function tokenCacheKey(vaultRoot: string, document: SearchDocument): string {
  return [
    vaultRoot,
    document.relPath,
    document.mtime,
    document.sizeBytes,
  ].join("\u0000");
}

function corpusFingerprint(vaultRoot: string, documents: SearchDocument[]): string {
  return [
    vaultRoot,
    ...documents.map((document) =>
      [
        document.relPath,
        document.mtime,
        document.sizeBytes,
      ].join("\u0000"),
    ),
  ].join("\u0001");
}

function trimBm25Cache(): void {
  while (bm25IndexCache.size > BM25_CACHE_MAX_ENTRIES) {
    const oldestKey = bm25IndexCache.keys().next().value;
    if (oldestKey === undefined) return;
    bm25IndexCache.delete(oldestKey);
  }
}

function trimBm25TokenCache(): void {
  while (bm25TokenCache.size > BM25_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = bm25TokenCache.keys().next().value;
    if (oldestKey === undefined) return;
    bm25TokenCache.delete(oldestKey);
  }
}

function lexicalSignalQuery(query: string): string {
  return tokenize(query)
    .filter((token) => !LEXICAL_STOPWORDS.has(token))
    .join(" ");
}

function dominantSource(result: RrfResult): string {
  return [...result.sources].sort(
    (a, b) => a.rank - b.rank || a.source.localeCompare(b.source),
  )[0]?.source ?? "unknown";
}

function rerankText(document: SearchDocument): string {
  return `${document.title}\n\n${document.snippetSource}\n\n${document.body}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function emptyTimings(): SearchTimings {
  return {
    corpusMs: 0,
    refreshMs: 0,
    embedQueryMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
    exactMs: 0,
    graphMs: 0,
    graphSpreadMs: 0,
    metadataMs: 0,
    rrfMs: 0,
    rerankMs: 0,
    totalMs: 0,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Search aborted");
  error.name = "AbortError";
  throw error;
}

function spreadingActivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MEMORY_FORT_SPREADING_ACTIVATION?.trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}
