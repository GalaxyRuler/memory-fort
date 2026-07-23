import { createHash } from "node:crypto";

import type { SearchResponse, SearchResult, SearchTimings } from "../retrieval/search.js";
import { buildProvenance } from "../retrieval/provenance-annotator.js";
import type { SearchScope } from "../retrieval/corpus.js";
import { canonicalizeAsOf } from "../retrieval/temporal-filter.js";
import { classifySearchKind, searchScopeSql } from "../search/kind.js";
import type { IndexDb, SqliteDatabase } from "./db.js";
import {
  type EmbedClient,
  type EmbeddingProfileFingerprint,
  createEmbeddingProfileFingerprint,
} from "./embed.js";
import { lexicalSearch, type LexicalSearchResult } from "./search.js";

export type VectorState =
  | "disabled"
  | "unavailable"
  | "model-loading"
  | "backfilling"
  | "partial"
  | "ready"
  | "failed";

export interface VectorCoverage {
  readonly embeddedEligible: number;
  readonly totalEligible: number;
}

export type HybridMode =
  | "lexical-only"
  | "lexical-plus-vector"
  | "vector-disabled-by-policy";

export type SearchCursorStatus = "ok" | "stale" | "invalid";

export interface SearchExecutor {
  search(req: SearchExecutorRequest): Promise<IndexSearchExecutorResponse>;
  close?(): void;
}

export interface SearchExecutorRequest {
  readonly query: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string | null;
  readonly signal?: AbortSignal;
  readonly scope?: SearchScope;
  readonly includeArchived?: boolean;
  readonly asOf?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly identityMode?: "inclusive" | "strict";
}

export type IndexSearchExecutorResponse = SearchResponse & {
  readonly vectorState: VectorState;
  readonly vectorCoverage: VectorCoverage;
  readonly hybridMode: HybridMode;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly cursorStatus?: SearchCursorStatus;
};

export interface InlineSearchExecutorOptions {
  readonly indexDb: IndexDb;
  readonly embedder?: VectorSearchEmbedClient | null;
  readonly profile?: EmbeddingProfileFingerprint;
  readonly vectorEnabled?: boolean;
  readonly coverageThreshold?: number;
  readonly queryCacheSize?: number;
  readonly queryEmbedTimeoutMs?: number;
  readonly maxConcurrentVectorSearches?: number;
  readonly k?: number;
  readonly oversample?: number;
}

export interface VectorSearchEmbedClient extends EmbedClient {
  readonly profile?: EmbeddingProfileFingerprint;
}

export interface VectorSearchOptions {
  readonly profile: EmbeddingProfileFingerprint;
  readonly queryVector: Float32Array;
  readonly k?: number;
  readonly oversample?: number;
  readonly scope?: SearchScope;
  readonly includeArchived?: boolean;
  readonly asOf?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly identityMode?: "inclusive" | "strict";
}

export interface VectorSearchResult {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
  readonly kind?: SearchResult["kind"] | null;
  readonly distance: number;
  readonly vectorRank: number;
  readonly sourceContentHash: string | null;
  readonly chunkTextHash: string | null;
  readonly indexGeneration: number | null;
  readonly indexedAt: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly observedAt: string | null;
  readonly confidence: number | null;
  readonly confidenceMetadata: unknown;
  readonly validation: string | null;
  readonly sourceFactCount: number | null;
  readonly derivedFromCount: number | null;
  readonly lexicalRank: number | null;
  readonly lexicalScore: number | null;
}

export interface ChunkRrfInput {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
  readonly kind?: SearchResult["kind"] | null;
  readonly sourceContentHash?: string | null;
  readonly chunkTextHash?: string | null;
  readonly indexGeneration?: number | null;
  readonly indexedAt?: number | null;
  readonly createdAt?: string | null;
  readonly updatedAt?: string | null;
  readonly observedAt?: string | null;
  readonly confidence?: number | null;
  readonly confidenceMetadata?: unknown;
  readonly validation?: string | null;
  readonly sourceFactCount?: number | null;
  readonly derivedFromCount?: number | null;
  readonly lexicalRank?: number | null;
  readonly lexicalScore?: number | null;
  readonly vectorRank?: number | null;
  readonly vectorDistance?: number | null;
}

export interface ChunkRrfSource {
  readonly source: "lexical" | "vector";
  readonly rank: number;
}

export interface ChunkRrfResult extends ChunkRrfInput {
  readonly score: number;
  readonly sources: readonly ChunkRrfSource[];
  readonly sourceCount: number;
  readonly bestRank: number;
}

export interface VectorReadiness {
  readonly vectorState: VectorState;
  readonly vectorCoverage: VectorCoverage;
  readonly hybridMode: HybridMode;
  readonly warnings: readonly string[];
}

export type VectorSearchFailureCode =
  | "query-embed-timeout"
  | "query-embed-failed"
  | "dtype-dim-mismatch"
  | "vec0-unavailable";

export class VectorSearchError extends Error {
  constructor(
    readonly code: VectorSearchFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VectorSearchError";
  }
}

interface MetaRow {
  readonly value: string | null;
}

interface CountRow {
  readonly count: number;
}

interface ActiveProfileRow extends Omit<EmbeddingProfileFingerprint, "profileId" | "dimension"> {
  readonly profileId: string;
  readonly dimension: number;
}

interface CoarseCandidateRow {
  readonly rowid: number | bigint;
  readonly coarseDistance: number;
}

interface RescoreRow {
  readonly embeddingRescore: Buffer;
}

interface QueryInt8Row {
  readonly vector: Buffer;
}

interface PayloadRow {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
  readonly kind: SearchResult["kind"] | null;
  readonly sourceContentHash: string | null;
  readonly chunkTextHash: string | null;
  readonly indexGeneration: number | null;
  readonly indexedAt: number | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly observedAt: string | null;
  readonly frontmatterConfidence: number | null;
  readonly frontmatterConfidenceJson: string | null;
  readonly validation: string | null;
  readonly sourceFactCount: number | null;
  readonly derivedFromCount: number | null;
}

interface CachedQueryVector {
  readonly vector: Float32Array;
}

const VECTOR_DIMENSION = 384;
const VECTOR_DTYPE = "binary-int8";
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_K = 20;
const DEFAULT_OVERSAMPLE = 2;
const DEFAULT_RRF_K = 60;
const DEFAULT_COVERAGE_THRESHOLD = 1;
const DEFAULT_QUERY_CACHE_SIZE = 128;
const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_VECTOR_SEARCHES = 1;
const TIEBREAK_VERSION = "chunk-rrf-score-source-best-rank-path-rowid-v1";

export class InlineSearchExecutor implements SearchExecutor {
  private readonly queryCache: LruQueryVectorCache;
  private readonly coverageThreshold: number;
  private readonly queryEmbedTimeoutMs: number;
  private readonly maxConcurrentVectorSearches: number;
  private activeVectorSearches = 0;
  private supersededSearch: AbortController | null = null;

  constructor(private readonly opts: InlineSearchExecutorOptions) {
    this.queryCache = new LruQueryVectorCache(opts.queryCacheSize ?? DEFAULT_QUERY_CACHE_SIZE);
    this.coverageThreshold = clampRatio(opts.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD);
    this.queryEmbedTimeoutMs = Math.max(1, Math.trunc(opts.queryEmbedTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS));
    this.maxConcurrentVectorSearches = Math.max(
      1,
      Math.trunc(opts.maxConcurrentVectorSearches ?? DEFAULT_MAX_CONCURRENT_VECTOR_SEARCHES),
    );
  }

  async search(req: SearchExecutorRequest): Promise<IndexSearchExecutorResponse> {
    const query = req.query.trim();
    const started = Date.now();
    const warnings: string[] = [];
    const supersession = new AbortController();
    const previous = this.supersededSearch;
    this.supersededSearch = supersession;
    previous?.abort();
    const signal = composeAbortSignals(req.signal, supersession.signal);
    const asOf = canonicalizeAsOf(req.asOf);

    try {
      throwIfAborted(signal);
      const profile = this.opts.profile ?? this.opts.embedder?.profile ?? readActiveEmbeddingProfile(this.opts.indexDb.database);
      const readiness = readVectorReadiness(this.opts.indexDb.database, {
        vectorEnabled: this.opts.vectorEnabled !== false,
        embedderAvailable: Boolean(this.opts.embedder),
        profile,
        coverageThreshold: this.coverageThreshold,
      });
      warnings.push(...readiness.warnings);
      const limit = clampLimit(req.limit);
      const fusionParams = searchFusionParams({
        k: this.opts.k,
        oversample: this.opts.oversample,
      });
      const cursorSnapshot = readSearchCursorSnapshot(this.opts.indexDb.database, {
        query,
        profile,
        readiness,
        fusionParams,
        limit,
        filters: { ...req, asOf },
      });
      const page = normalizePage(req, cursorSnapshot);
      warnings.push(...page.warnings);

      const lexical = lexicalSearch(this.opts.indexDb, query, {
        limit: page.fetchLimit,
        scope: req.scope,
        includeArchived: req.includeArchived,
        asOf,
        agentId: req.agentId,
        userId: req.userId,
        identityMode: req.identityMode,
      });
      if (!query || readiness.hybridMode !== "lexical-plus-vector" || !profile || !this.opts.embedder) {
        return lexicalOnlyResponse({
          query,
          lexical,
          page,
          started,
          warnings,
          readiness,
          cursorSnapshot,
        });
      }
      if (this.activeVectorSearches >= this.maxConcurrentVectorSearches) {
        return lexicalOnlyResponse({
          query,
          lexical,
          page,
          started,
          warnings: [...warnings, "vector search skipped: concurrency cap reached"],
          readiness: {
            ...readiness,
            hybridMode: "lexical-only",
          },
          cursorSnapshot: {
            ...cursorSnapshot,
            hybridMode: "lexical-only",
          },
        });
      }

      this.activeVectorSearches += 1;
      try {
        const queryVector = await this.queryCache.getOrEmbed({
          query,
          profile,
          embedder: this.opts.embedder,
          timeoutMs: this.queryEmbedTimeoutMs,
          signal,
        });
        throwIfAborted(signal);
        const vector = twoStageVectorSearch(this.opts.indexDb.database, {
          profile,
          queryVector,
          k: fusionParams.k,
          oversample: fusionParams.oversample,
          scope: req.scope,
          includeArchived: req.includeArchived,
          asOf,
          agentId: req.agentId,
          userId: req.userId,
          identityMode: req.identityMode,
        });
        const fused = fuseChunkRrf({
          lexical,
          vector,
          limit: page.fetchLimit,
        });
        return hybridResponse({
          query,
          fused,
          page,
          started,
          warnings,
          readiness,
          cursorSnapshot,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        const failedReadiness: VectorReadiness = {
          vectorState: "failed",
          vectorCoverage: readiness.vectorCoverage,
          hybridMode: "lexical-only",
          warnings: [],
        };
        return lexicalOnlyResponse({
          query,
          lexical,
          page,
          started,
          warnings: [...warnings, `vector search failed: ${errorMessage(error)}`],
          readiness: failedReadiness,
          cursorSnapshot: {
            ...cursorSnapshot,
            hybridMode: "lexical-only",
          },
        });
      } finally {
        this.activeVectorSearches -= 1;
      }
    } finally {
      if (this.supersededSearch === supersession) this.supersededSearch = null;
    }
  }

  close(): void {
    this.supersededSearch?.abort();
    this.supersededSearch = null;
  }
}

export function twoStageVectorSearch(database: SqliteDatabase, opts: VectorSearchOptions): VectorSearchResult[] {
  assertSearchProfile(opts.profile);
  assertQueryVector(opts.queryVector, opts.profile);
  const k = clampLimit(opts.k ?? DEFAULT_K);
  const oversample = Math.max(1, Math.trunc(opts.oversample ?? DEFAULT_OVERSAMPLE));
  const queryBuffer = float32VectorBuffer(opts.queryVector);
  const queryInt8 = database
    .prepare<[Buffer], QueryInt8Row>("SELECT vec_quantize_int8(?, 'unit') AS vector")
    .get(queryBuffer)?.vector;
  if (!Buffer.isBuffer(queryInt8)) {
    throw new VectorSearchError("vec0-unavailable", "query int8 quantization did not return a buffer");
  }

  const asOf = canonicalizeAsOf(opts.asOf);
  const temporalParams = asOf ? [asOf, asOf] : [];
  const identityFilter = vectorIdentitySql(opts, "f");
  const coarse = database
    .prepare<unknown[], CoarseCandidateRow>(`
      SELECT chunk_vectors_bin.rowid AS rowid, distance AS coarseDistance
      FROM chunk_vectors_bin
      WHERE embedding MATCH vec_quantize_binary(?)
        AND chunk_vectors_bin.rowid IN (
          SELECT cv.coarseRowid
          FROM chunk_vectors cv
          JOIN chunks c ON c.rowid = cv.chunkRowid
          JOIN files f ON f.relPath = c.relPath
          WHERE ${searchScopeSql(opts.scope ?? "all", "f")}
            AND ${opts.includeArchived === true ? "1 = 1" : vectorActiveDocumentSql("f")}
            AND ${asOf ? vectorTemporalValiditySql("f") : "1 = 1"}
            AND ${identityFilter.sql}
        )
      ORDER BY distance
      LIMIT ?
    `)
    .all(queryBuffer, ...temporalParams, ...identityFilter.params, k * oversample);
  const rescore = database.prepare<[number | bigint], RescoreRow>(
    "SELECT embedding AS embeddingRescore FROM chunk_vectors_i8 WHERE rowid = ?",
  );
  const payload = database.prepare<[number | bigint, string], PayloadRow>(`
    SELECT
      c.rowid AS rowid,
      c.chunkId AS chunkId,
      c.relPath AS relPath,
      c.ordinal AS ordinal,
      c.headingPath AS headingPath,
      c.byteStart AS byteStart,
      c.byteEnd AS byteEnd,
      c.text AS text,
      c.textHash AS chunkTextHash,
      c.generation AS indexGeneration,
      f.kind AS kind,
      f.contentHash AS sourceContentHash,
      f.indexedAt AS indexedAt,
      f.frontmatterCreated AS createdAt,
      f.frontmatterUpdated AS updatedAt,
      f.frontmatterObservedAt AS observedAt,
      f.frontmatterConfidence AS frontmatterConfidence,
      f.frontmatterConfidenceJson AS frontmatterConfidenceJson,
      f.frontmatterValidation AS validation,
      f.sourceFactCount AS sourceFactCount,
      f.derivedFromCount AS derivedFromCount
    FROM chunk_vectors cv
    JOIN chunks c ON c.rowid = cv.chunkRowid
    JOIN files f ON f.relPath = c.relPath
    WHERE cv.coarseRowid = ? AND cv.profileId = ? AND cv.status = 'embedded'
  `);

  return coarse
    .map((candidate): (PayloadRow & { readonly coarseRowid: number | bigint; readonly distance: number; readonly vectorRank: number }) | null => {
      const stored = rescore.get(candidate.rowid)?.embeddingRescore;
      if (!Buffer.isBuffer(stored)) return null;
      const row = payload.get(candidate.rowid, opts.profile.profileId);
      if (!row) return null;
      return {
        ...row,
        coarseRowid: candidate.rowid,
        distance: int8L2Distance(stored, queryInt8),
        vectorRank: 0,
      };
    })
    .filter((row): row is PayloadRow & { readonly coarseRowid: number | bigint; readonly distance: number; readonly vectorRank: number } => row !== null)
    .sort((a, b) => a.distance - b.distance || a.relPath.localeCompare(b.relPath) || a.rowid - b.rowid)
    .slice(0, k)
    .map((row, index) => ({
      rowid: row.rowid,
      chunkId: row.chunkId,
      relPath: row.relPath,
      ordinal: row.ordinal,
      headingPath: row.headingPath,
      byteStart: row.byteStart,
      byteEnd: row.byteEnd,
      text: row.text,
      kind: row.kind,
      sourceContentHash: row.sourceContentHash,
      chunkTextHash: row.chunkTextHash,
      indexGeneration: row.indexGeneration,
      indexedAt: row.indexedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      observedAt: row.observedAt,
      confidence: row.frontmatterConfidence,
      confidenceMetadata: parseConfidenceMetadata(row.frontmatterConfidenceJson, row.frontmatterConfidence),
      validation: row.validation,
      sourceFactCount: row.sourceFactCount,
      derivedFromCount: row.derivedFromCount,
      lexicalRank: null,
      lexicalScore: null,
      distance: row.distance,
      vectorRank: index + 1,
    }));
}

export function fuseChunkRrf(opts: {
  readonly lexical: readonly LexicalSearchResult[];
  readonly vector: readonly VectorSearchResult[];
  readonly limit?: number;
  readonly k?: number;
}): ChunkRrfResult[] {
  const k = opts.k ?? DEFAULT_RRF_K;
  const byChunk = new Map<string, MutableChunkRrfResult>();
  const add = (source: ChunkRrfSource["source"], rank: number, item: ChunkRrfInput): void => {
    const key = item.chunkId || String(item.rowid);
    const existing =
      byChunk.get(key) ??
      ({
        ...item,
        score: 0,
        sources: [],
        sourceCount: 0,
        bestRank: Number.POSITIVE_INFINITY,
      } satisfies MutableChunkRrfResult);
    existing.score += 1 / (k + rank);
    existing.sources.push({ source, rank });
    const mutable = existing as MutableChunkRrfResult & {
      lexicalRank?: number | null;
      vectorRank?: number | null;
      vectorDistance?: number | null;
    };
    if (source === "lexical") mutable.lexicalRank = rank;
    if (source === "vector") {
      mutable.vectorRank = rank;
      mutable.vectorDistance = (item as VectorSearchResult).distance;
    }
    existing.sourceCount = new Set(existing.sources.map((entry) => entry.source)).size;
    existing.bestRank = Math.min(existing.bestRank, rank);
    byChunk.set(key, existing);
  };

  opts.lexical.forEach((item, index) => add("lexical", index + 1, item));
  opts.vector.forEach((item, index) => add("vector", index + 1, item));

  const sortedChunks = [...byChunk.values()]
    .map((item): ChunkRrfResult => ({
      ...item,
      sources: [...item.sources].sort((a, b) => a.source.localeCompare(b.source) || a.rank - b.rank),
    }))
    .sort(compareFusedChunks);

  const byParent = new Map<string, ChunkRrfResult>();
  for (const chunk of sortedChunks) {
    if (!byParent.has(chunk.relPath)) byParent.set(chunk.relPath, chunk);
  }
  return [...byParent.values()].slice(0, clampLimit(opts.limit ?? DEFAULT_LIMIT));
}

export function readVectorReadiness(database: SqliteDatabase, opts: {
  readonly vectorEnabled?: boolean;
  readonly embedderAvailable?: boolean;
  readonly profile?: EmbeddingProfileFingerprint | null;
  readonly coverageThreshold?: number;
}): VectorReadiness {
  const profile = opts.profile ?? readActiveEmbeddingProfile(database);
  const coverage = readVectorCoverage(database, profile?.profileId ?? null);
  if (opts.vectorEnabled === false) {
    return {
      vectorState: "disabled",
      vectorCoverage: coverage,
      hybridMode: "vector-disabled-by-policy",
      warnings: ["vector search disabled by policy"],
    };
  }
  if (!opts.embedderAvailable) {
    return {
      vectorState: "unavailable",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: ["vector search unavailable: query embedder is not loaded"],
    };
  }
  if (!profile) {
    return {
      vectorState: "unavailable",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: ["vector search unavailable: no active embedding profile"],
    };
  }
  if (profile.dtype !== VECTOR_DTYPE || profile.dimension !== VECTOR_DIMENSION) {
    return {
      vectorState: "unavailable",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: [`vector search unavailable: unsupported profile ${profile.dtype}/${profile.dimension}`],
    };
  }
  if (!vec0TablesAvailable(database)) {
    return {
      vectorState: "unavailable",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: ["vector search unavailable: sqlite-vec tables are not available"],
    };
  }

  if (coverage.totalEligible === 0) {
    return {
      vectorState: "ready",
      vectorCoverage: coverage,
      hybridMode: "lexical-plus-vector",
      warnings: [],
    };
  }
  const ratio = coverage.embeddedEligible / coverage.totalEligible;
  const threshold = clampRatio(opts.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD);
  if (coverage.embeddedEligible === 0) {
    return {
      vectorState: "backfilling",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: ["vector search waiting for vector backfill"],
    };
  }
  if (ratio < threshold) {
    return {
      vectorState: "partial",
      vectorCoverage: coverage,
      hybridMode: "lexical-only",
      warnings: [`vector search waiting for coverage ${coverage.embeddedEligible}/${coverage.totalEligible}`],
    };
  }
  return {
    vectorState: "ready",
    vectorCoverage: coverage,
    hybridMode: "lexical-plus-vector",
    warnings: [],
  };
}

export function readActiveEmbeddingProfile(database: SqliteDatabase): EmbeddingProfileFingerprint | null {
  const profileId = readMeta(database, "activeEmbeddingProfileId");
  if (!profileId) return null;
  const row = database
    .prepare<[string], ActiveProfileRow>(
      `SELECT
        profileId, provider, runtime, runtimeVersion, modelId, modelRevision,
        modelHash, tokenizerHash, pooling, normalization, dtype, dimension,
        prefixStrategy, chunkerVersion, payloadRecipe, maxTokenPolicy
      FROM embedding_profiles
      WHERE profileId = ?`,
    )
    .get(profileId);
  if (!row) return null;
  return createEmbeddingProfileFingerprint({
    provider: row.provider,
    runtime: row.runtime,
    runtimeVersion: row.runtimeVersion,
    modelId: row.modelId,
    modelRevision: row.modelRevision,
    modelHash: row.modelHash,
    tokenizerHash: row.tokenizerHash,
    pooling: row.pooling,
    normalization: row.normalization,
    dtype: row.dtype,
    dimension: row.dimension,
    prefixStrategy: row.prefixStrategy,
    chunkerVersion: row.chunkerVersion,
    payloadRecipe: row.payloadRecipe,
    maxTokenPolicy: row.maxTokenPolicy,
  });
}

class LruQueryVectorCache {
  private readonly entries = new Map<string, CachedQueryVector>();

  constructor(private readonly maxEntries: number) {}

  async getOrEmbed(opts: {
    readonly query: string;
    readonly profile: EmbeddingProfileFingerprint;
    readonly embedder: EmbedClient;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<Float32Array> {
    const key = queryCacheKey(opts.query, opts.profile);
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.vector;
    }

    const vector = await embedQueryVector(opts);
    this.entries.set(key, { vector });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return vector;
  }
}

type MutableChunkRrfResult = ChunkRrfInput & {
  score: number;
  sources: ChunkRrfSource[];
  sourceCount: number;
  bestRank: number;
};

interface SearchFusionParams {
  readonly rrfK: number;
  readonly k: number;
  readonly oversample: number;
  readonly dedupPolicy: "parent-best-v1";
}

interface CursorKeysetPosition {
  readonly fusedScore: number;
  readonly relPath: string;
  readonly rowid: number;
}

interface SearchCursorSnapshot {
  readonly queryFingerprint: string;
  readonly lexicalGeneration: string;
  readonly vectorGeneration: string;
  readonly embeddingProfileId: string | null;
  readonly hybridMode: HybridMode;
  readonly vectorCoverageAtQuery: VectorCoverage;
  readonly fusionParams: SearchFusionParams;
  readonly tiebreakVersion: string;
  readonly limit: number;
}

type SearchCursorPayload = SearchCursorSnapshot & {
  readonly position: CursorKeysetPosition | null;
};

interface PageOptions {
  readonly cursor: string | null;
  readonly limit: number;
  readonly fetchLimit: number;
  readonly position: CursorKeysetPosition | null;
  readonly cursorStatus?: SearchCursorStatus;
  readonly warnings: readonly string[];
}

function lexicalOnlyResponse(opts: {
  readonly query: string;
  readonly lexical: readonly LexicalSearchResult[];
  readonly page: PageOptions;
  readonly started: number;
  readonly warnings: readonly string[];
  readonly readiness: VectorReadiness;
  readonly cursorSnapshot: SearchCursorSnapshot;
}): IndexSearchExecutorResponse {
  const page = paginateByKeyset(opts.lexical, opts.page, lexicalKeysetPosition);
  const warnings = [...opts.warnings, ...page.warnings];
  return {
    ...baseResponse(opts.query, opts.started, opts.readiness, warnings),
    results: page.results.map((result, index) => lexicalToSearchResult(result, page.startRank + index)),
    degraded: warnings.length > 0 || opts.readiness.hybridMode !== "lexical-plus-vector",
    bm25Cache: {
      indexCacheHit: true,
      documentCount: opts.readiness.vectorCoverage.totalEligible,
      tokenCacheHits: 0,
      tokenCacheMisses: 0,
    },
    cursor: page.cursor,
    nextCursor: page.nextPosition ? encodeSearchCursor(opts.cursorSnapshot, page.nextPosition) : null,
    ...(page.cursorStatus ? { cursorStatus: page.cursorStatus } : {}),
  };
}

function hybridResponse(opts: {
  readonly query: string;
  readonly fused: readonly ChunkRrfResult[];
  readonly page: PageOptions;
  readonly started: number;
  readonly warnings: readonly string[];
  readonly readiness: VectorReadiness;
  readonly cursorSnapshot: SearchCursorSnapshot;
}): IndexSearchExecutorResponse {
  const page = paginateByKeyset(opts.fused, opts.page, fusedKeysetPosition);
  const warnings = [...opts.warnings, ...page.warnings];
  return {
    ...baseResponse(opts.query, opts.started, opts.readiness, warnings),
    results: page.results.map(fusedToSearchResult),
    degraded: warnings.length > 0,
    bm25Cache: {
      indexCacheHit: true,
      documentCount: opts.readiness.vectorCoverage.totalEligible,
      tokenCacheHits: 0,
      tokenCacheMisses: 0,
    },
    cursor: page.cursor,
    nextCursor: page.nextPosition ? encodeSearchCursor(opts.cursorSnapshot, page.nextPosition) : null,
    ...(page.cursorStatus ? { cursorStatus: page.cursorStatus } : {}),
  };
}

interface PaginatedKeyset<T> {
  readonly results: readonly T[];
  readonly startRank: number;
  readonly cursor: string | null;
  readonly nextPosition: CursorKeysetPosition | null;
  readonly cursorStatus?: SearchCursorStatus;
  readonly warnings: readonly string[];
}

function paginateByKeyset<T>(
  items: readonly T[],
  page: PageOptions,
  keyFor: (item: T) => CursorKeysetPosition,
): PaginatedKeyset<T> {
  let startIndex = 0;
  if (page.position) {
    const found = items.findIndex((item) => keysetPositionEquals(keyFor(item), page.position!));
    if (found < 0) {
      return pageFromIndex(items, 0, page, keyFor, {
        cursor: null,
        cursorStatus: "stale",
        warnings: ["cursor-stale: position changed"],
      });
    }
    startIndex = found + 1;
  }
  return pageFromIndex(items, startIndex, page, keyFor, {
    cursor: page.cursor,
    cursorStatus: page.cursorStatus,
    warnings: [],
  });
}

function pageFromIndex<T>(
  items: readonly T[],
  startIndex: number,
  page: PageOptions,
  keyFor: (item: T) => CursorKeysetPosition,
  cursor: {
    readonly cursor: string | null;
    readonly cursorStatus?: SearchCursorStatus;
    readonly warnings: readonly string[];
  },
): PaginatedKeyset<T> {
  const results = items.slice(startIndex, startIndex + page.limit);
  const nextIndex = startIndex + results.length;
  const last = results.at(-1);
  return {
    results,
    startRank: startIndex + 1,
    cursor: cursor.cursor,
    nextPosition: last && items.length > nextIndex ? keyFor(last) : null,
    ...(cursor.cursorStatus ? { cursorStatus: cursor.cursorStatus } : {}),
    warnings: cursor.warnings,
  };
}

function lexicalKeysetPosition(result: LexicalSearchResult): CursorKeysetPosition {
  return {
    fusedScore: -result.score,
    relPath: result.relPath,
    rowid: result.rowid,
  };
}

function fusedKeysetPosition(result: ChunkRrfResult): CursorKeysetPosition {
  return {
    fusedScore: result.score,
    relPath: result.relPath,
    rowid: result.rowid,
  };
}

function keysetPositionEquals(left: CursorKeysetPosition, right: CursorKeysetPosition): boolean {
  return left.rowid === right.rowid
    && left.relPath === right.relPath
    && left.fusedScore === right.fusedScore;
}

function baseResponse(
  query: string,
  started: number,
  readiness: VectorReadiness,
  warnings: readonly string[],
): Omit<IndexSearchExecutorResponse, "results" | "degraded" | "bm25Cache" | "cursor" | "nextCursor"> {
  return {
    query,
    warnings: [...warnings],
    timings: indexSearchTimings(started),
    hyde: { used: false, reason: "disabled-by-flag" },
    corpusErrorCount: 0,
    vectorState: readiness.vectorState,
    vectorCoverage: readiness.vectorCoverage,
    hybridMode: readiness.hybridMode,
  };
}

function fusedToSearchResult(result: ChunkRrfResult): SearchResult {
  const source = dominantSource(result.sources);
  const kind = classifySearchKind({ relPath: result.relPath, kind: result.kind });
  const sources = result.sources.map((entry) => ({ source: entry.source, rank: entry.rank }));
  const confidenceMetadata = result.confidenceMetadata ?? result.confidence ?? null;
  return {
    path: result.relPath,
    title: titleFromChunk(result),
    snippet: result.text,
    score: result.score,
    source,
    sources,
    kind,
    provenance: buildProvenance({
      relPath: result.relPath,
      kind,
      confidenceFull: confidenceMetadata,
      sourceFactCount: result.sourceFactCount ?? null,
      derivedFromCount: result.derivedFromCount ?? null,
    }, source, sources, {
      confidenceMetadata,
      validation: result.validation ?? null,
      chunkId: result.chunkId,
      chunkOrdinal: result.ordinal,
      byteStart: result.byteStart,
      byteEnd: result.byteEnd,
      sourceContentHash: result.sourceContentHash ?? null,
      chunkTextHash: result.chunkTextHash ?? null,
      indexGeneration: result.indexGeneration ?? null,
      indexedAt: result.indexedAt == null ? null : new Date(result.indexedAt).toISOString(),
      createdAt: result.createdAt ?? null,
      updatedAt: result.updatedAt ?? null,
      observedAt: result.observedAt ?? null,
      lexicalRank: result.lexicalRank ?? null,
      lexicalScore: result.lexicalScore ?? null,
      vectorRank: result.vectorRank ?? null,
      vectorDistance: result.vectorDistance ?? null,
    }),
  };
}

function lexicalToSearchResult(result: LexicalSearchResult, rank: number): SearchResult {
  const source = "index";
  const kind = classifySearchKind({ relPath: result.relPath, kind: result.kind });
  const signals = [{ source, rank }];
  return {
    path: result.relPath,
    title: titleFromChunk(result),
    snippet: result.text,
    score: result.score,
    source,
    sources: signals,
    kind,
    provenance: buildProvenance({
      relPath: result.relPath,
      kind,
      confidenceFull: result.confidenceMetadata,
      sourceFactCount: result.sourceFactCount,
      derivedFromCount: result.derivedFromCount,
    }, source, signals, {
      confidenceMetadata: result.confidenceMetadata,
      validation: result.validation,
      chunkId: result.chunkId,
      chunkOrdinal: result.ordinal,
      byteStart: result.byteStart,
      byteEnd: result.byteEnd,
      sourceContentHash: result.sourceContentHash,
      chunkTextHash: result.chunkTextHash,
      indexGeneration: result.indexGeneration,
      indexedAt: result.indexedAt === null ? null : new Date(result.indexedAt).toISOString(),
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
      observedAt: result.observedAt,
      lexicalRank: rank,
      lexicalScore: result.lexicalScore,
      vectorRank: null,
      vectorDistance: null,
    }),
  };
}

function indexSearchTimings(started: number): SearchTimings {
  const elapsed = Math.max(0, Date.now() - started);
  return {
    corpusMs: 0,
    refreshMs: 0,
    embedQueryMs: 0,
    bm25Ms: elapsed,
    vectorMs: 0,
    exactMs: 0,
    graphMs: 0,
    graphSpreadMs: 0,
    metadataMs: 0,
    rrfMs: 0,
    rerankMs: 0,
    totalMs: elapsed,
    intentClassification: {
      label: "open-ended",
      confidence: 0.5,
      method: "fallback",
      latencyMs: 0,
    },
  };
}

function titleFromChunk(result: { readonly relPath: string; readonly headingPath: string | null }): string {
  if (result.headingPath) {
    const parts = result.headingPath.split(">").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts.at(-1)!;
  }
  const slash = result.relPath.lastIndexOf("/");
  const basename = slash >= 0 ? result.relPath.slice(slash + 1) : result.relPath;
  return basename.replace(/\.md$/i, "");
}

function dominantSource(sources: readonly ChunkRrfSource[]): string {
  return [...sources].sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source))[0]?.source ?? "index";
}

function compareFusedChunks(a: ChunkRrfResult, b: ChunkRrfResult): number {
  return (
    b.score - a.score ||
    b.sourceCount - a.sourceCount ||
    a.bestRank - b.bestRank ||
    a.relPath.localeCompare(b.relPath) ||
    a.rowid - b.rowid
  );
}

async function embedQueryVector(opts: {
  readonly query: string;
  readonly profile: EmbeddingProfileFingerprint;
  readonly embedder: EmbedClient;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<Float32Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  const signal = composeAbortSignals(opts.signal, controller.signal);
  try {
    throwIfAborted(signal);
    const vectors = await opts.embedder.embed([normalizeQueryForEmbedding(opts.query)], { signal });
    throwIfAborted(signal);
    const vector = vectors[0];
    if (!(vector instanceof Float32Array) || vector.length !== opts.profile.dimension) {
      throw new VectorSearchError(
        "dtype-dim-mismatch",
        `query embedding returned invalid dim ${String(vector?.length)}`,
      );
    }
    return vector;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (controller.signal.aborted) {
      throw new VectorSearchError("query-embed-timeout", `query embedding exceeded ${opts.timeoutMs}ms`, {
        cause: error,
      });
    }
    if (error instanceof VectorSearchError) throw error;
    throw new VectorSearchError("query-embed-failed", errorMessage(error), { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeQueryForEmbedding(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function queryCacheKey(query: string, profile: EmbeddingProfileFingerprint): string {
  return [
    normalizeQueryForEmbedding(query).toLowerCase(),
    profile.profileId,
    profile.dimension,
    profile.prefixStrategy,
  ].join("\u0000");
}

function readVectorCoverage(database: SqliteDatabase, profileId: string | null): VectorCoverage {
  const totalEligible = database.prepare<[], CountRow>("SELECT count(*) AS count FROM chunks").get()?.count ?? 0;
  if (!profileId) return { embeddedEligible: 0, totalEligible };
  const embeddedEligible = database
    .prepare<[string], CountRow>(
      "SELECT count(*) AS count FROM chunk_vectors WHERE profileId = ? AND status = 'embedded'",
    )
    .get(profileId)?.count ?? 0;
  return { embeddedEligible, totalEligible };
}

function vec0TablesAvailable(database: SqliteDatabase): boolean {
  try {
    database.prepare<[], CountRow>("SELECT count(*) AS count FROM chunk_vectors_bin").get();
    database.prepare<[], CountRow>("SELECT count(*) AS count FROM chunk_vectors_i8").get();
    return true;
  } catch {
    return false;
  }
}

function readMeta(database: SqliteDatabase, key: string): string | null {
  return database.prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

function assertSearchProfile(profile: EmbeddingProfileFingerprint): void {
  if (profile.dimension !== VECTOR_DIMENSION || profile.dtype !== VECTOR_DTYPE) {
    throw new VectorSearchError(
      "dtype-dim-mismatch",
      `expected ${VECTOR_DTYPE}/${VECTOR_DIMENSION} profile, got ${profile.dtype}/${profile.dimension}`,
    );
  }
}

function assertQueryVector(vector: Float32Array, profile: EmbeddingProfileFingerprint): void {
  if (!(vector instanceof Float32Array) || vector.length !== profile.dimension) {
    throw new VectorSearchError("dtype-dim-mismatch", `query vector dim ${vector.length} does not match ${profile.dimension}`);
  }
}

function float32VectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function int8L2Distance(left: Buffer, right: Buffer): number {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const diff = left.readInt8(index) - right.readInt8(index);
    sum += diff * diff;
  }
  return sum;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COVERAGE_THRESHOLD;
  return Math.max(0, Math.min(1, value));
}

function searchFusionParams(opts: {
  readonly k?: number;
  readonly oversample?: number;
}): SearchFusionParams {
  return {
    rrfK: DEFAULT_RRF_K,
    k: clampLimit(opts.k ?? MAX_LIMIT),
    oversample: Math.max(1, Math.trunc(opts.oversample ?? DEFAULT_OVERSAMPLE)),
    dedupPolicy: "parent-best-v1",
  };
}

function readSearchCursorSnapshot(database: SqliteDatabase, opts: {
  readonly query: string;
  readonly profile: EmbeddingProfileFingerprint | null;
  readonly readiness: VectorReadiness;
  readonly fusionParams: SearchFusionParams;
  readonly limit: number;
  readonly filters: SearchExecutorRequest;
}): SearchCursorSnapshot {
  return {
    queryFingerprint: fingerprintSearchQuery(opts.query, opts.fusionParams, opts.filters),
    lexicalGeneration: readLexicalGeneration(database),
    vectorGeneration: readMeta(database, "vectorGeneration") ?? "0",
    embeddingProfileId: opts.profile?.profileId ?? null,
    hybridMode: opts.readiness.hybridMode,
    vectorCoverageAtQuery: opts.readiness.vectorCoverage,
    fusionParams: opts.fusionParams,
    tiebreakVersion: TIEBREAK_VERSION,
    limit: opts.limit,
  };
}

function normalizePage(req: SearchExecutorRequest, snapshot: SearchCursorSnapshot): PageOptions {
  const cursor = req.cursor?.trim() || null;
  const legacyOffset = req.offset ?? 0;
  if (!cursor) {
    const invalidOffset = legacyOffset > 0;
    return {
      cursor: null,
      limit: snapshot.limit,
      fetchLimit: MAX_LIMIT,
      position: null,
      ...(invalidOffset ? { cursorStatus: "invalid" as const } : {}),
      warnings: invalidOffset ? ["cursor-invalid"] : [],
    };
  }

  const payload = decodeSearchCursor(cursor);
  if (!payload) {
    return {
      cursor: null,
      limit: snapshot.limit,
      fetchLimit: MAX_LIMIT,
      position: null,
      cursorStatus: "invalid",
      warnings: ["cursor-invalid"],
    };
  }

  const staleReason = cursorStaleReason(payload, snapshot);
  if (staleReason) {
    return {
      cursor: null,
      limit: snapshot.limit,
      fetchLimit: MAX_LIMIT,
      position: null,
      cursorStatus: "stale",
      warnings: [`cursor-stale: ${staleReason}`],
    };
  }

  return {
    cursor,
    limit: snapshot.limit,
    fetchLimit: MAX_LIMIT,
    position: payload.position,
    cursorStatus: "ok",
    warnings: [],
  };
}

function encodeSearchCursor(snapshot: SearchCursorSnapshot, position: CursorKeysetPosition): string {
  const payload: SearchCursorPayload = {
    queryFingerprint: snapshot.queryFingerprint,
    lexicalGeneration: snapshot.lexicalGeneration,
    vectorGeneration: snapshot.vectorGeneration,
    embeddingProfileId: snapshot.embeddingProfileId,
    hybridMode: snapshot.hybridMode,
    vectorCoverageAtQuery: snapshot.vectorCoverageAtQuery,
    fusionParams: snapshot.fusionParams,
    tiebreakVersion: snapshot.tiebreakVersion,
    limit: snapshot.limit,
    position,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) return null;
    const keys = Object.keys(parsed).sort();
    if (keys.join("\0") !== SEARCH_CURSOR_KEYS.join("\0")) return null;
    const payload = parsed as Record<string, unknown>;
    if (
      typeof payload["queryFingerprint"] !== "string" ||
      typeof payload["lexicalGeneration"] !== "string" ||
      typeof payload["vectorGeneration"] !== "string" ||
      !isNullableString(payload["embeddingProfileId"]) ||
      !isHybridMode(payload["hybridMode"]) ||
      !isVectorCoverage(payload["vectorCoverageAtQuery"]) ||
      !isSearchFusionParams(payload["fusionParams"]) ||
      typeof payload["tiebreakVersion"] !== "string" ||
      !Number.isInteger(payload["limit"]) ||
      !isCursorKeysetPositionOrNull(payload["position"])
    ) {
      return null;
    }
    return {
      queryFingerprint: payload["queryFingerprint"],
      lexicalGeneration: payload["lexicalGeneration"],
      vectorGeneration: payload["vectorGeneration"],
      embeddingProfileId: payload["embeddingProfileId"],
      hybridMode: payload["hybridMode"],
      vectorCoverageAtQuery: payload["vectorCoverageAtQuery"],
      fusionParams: payload["fusionParams"],
      tiebreakVersion: payload["tiebreakVersion"],
      limit: payload["limit"] as number,
      position: payload["position"],
    };
  } catch {
    return null;
  }
}

const SEARCH_CURSOR_KEYS = [
  "embeddingProfileId",
  "fusionParams",
  "hybridMode",
  "lexicalGeneration",
  "limit",
  "position",
  "queryFingerprint",
  "tiebreakVersion",
  "vectorCoverageAtQuery",
  "vectorGeneration",
];

function cursorStaleReason(payload: SearchCursorPayload, snapshot: SearchCursorSnapshot): string | null {
  if (payload.limit !== snapshot.limit) return "limit changed";
  if (payload.embeddingProfileId !== snapshot.embeddingProfileId) return "embeddingProfileId changed";
  if (payload.hybridMode !== snapshot.hybridMode) return "hybridMode changed";
  if (payload.lexicalGeneration !== snapshot.lexicalGeneration) return "lexicalGeneration changed";
  if (payload.vectorGeneration !== snapshot.vectorGeneration) return "vectorGeneration changed";
  if (!sameVectorCoverage(payload.vectorCoverageAtQuery, snapshot.vectorCoverageAtQuery)) {
    return "vectorCoverageAtQuery changed";
  }
  if (!sameFusionParams(payload.fusionParams, snapshot.fusionParams)) return "fusionParams changed";
  if (payload.tiebreakVersion !== snapshot.tiebreakVersion) return "tiebreakVersion changed";
  if (payload.queryFingerprint !== snapshot.queryFingerprint) return "queryFingerprint changed";
  return null;
}

function sameVectorCoverage(left: VectorCoverage, right: VectorCoverage): boolean {
  return left.embeddedEligible === right.embeddedEligible && left.totalEligible === right.totalEligible;
}

function sameFusionParams(left: SearchFusionParams, right: SearchFusionParams): boolean {
  return left.rrfK === right.rrfK
    && left.k === right.k
    && left.oversample === right.oversample
    && left.dedupPolicy === right.dedupPolicy;
}

function fingerprintSearchQuery(
  query: string,
  fusionParams: SearchFusionParams,
  filters: SearchExecutorRequest,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      fusionParams,
      query: normalizeQueryForEmbedding(query),
      filters: {
        scope: filters.scope ?? "all",
        includeArchived: filters.includeArchived === true,
        asOf: canonicalizeAsOf(filters.asOf) ?? null,
        agentId: filters.agentId ?? null,
        userId: filters.userId ?? null,
        identityMode: filters.identityMode ?? "inclusive",
      },
    }))
    .digest("hex");
}

function readLexicalGeneration(database: SqliteDatabase): string {
  return readMeta(database, "lastCompleteRunId")
    ?? readMeta(database, "lastCompleteReconcileAt")
    ?? "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfidenceMetadata(value: string | null, fallback: number | null): unknown {
  if (value) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Fall through to the scalar value persisted beside malformed legacy JSON.
    }
  }
  return fallback;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isHybridMode(value: unknown): value is HybridMode {
  return value === "lexical-only"
    || value === "lexical-plus-vector"
    || value === "vector-disabled-by-policy";
}

function isVectorCoverage(value: unknown): value is VectorCoverage {
  return isRecord(value)
    && Number.isInteger(value["embeddedEligible"])
    && Number.isInteger(value["totalEligible"]);
}

function isSearchFusionParams(value: unknown): value is SearchFusionParams {
  return isRecord(value)
    && value["rrfK"] === DEFAULT_RRF_K
    && Number.isInteger(value["k"])
    && Number.isInteger(value["oversample"])
    && value["dedupPolicy"] === "parent-best-v1";
}

function isCursorKeysetPositionOrNull(value: unknown): value is CursorKeysetPosition | null {
  return value === null || (
    isRecord(value)
    && typeof value["fusedScore"] === "number"
    && Number.isFinite(value["fusedScore"])
    && typeof value["relPath"] === "string"
    && Number.isInteger(value["rowid"])
  );
}

function composeAbortSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  if (first.aborted) return first;
  if (second.aborted) return second;
  const controller = new AbortController();
  const abort = () => controller.abort();
  first.addEventListener("abort", abort, { once: true });
  second.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Search aborted");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}


function vectorActiveDocumentSql(filesAlias: string): string {
  return [
    `coalesce(${filesAlias}.frontmatterStatus, '') NOT IN ('archived', 'superseded')`,
    `coalesce(${filesAlias}.frontmatterLifecycle, '') <> 'archived'`,
    `${filesAlias}.relPath NOT GLOB 'wiki/archive/*'`,
    `${filesAlias}.relPath NOT GLOB 'wiki/.archive/*'`,
    `${filesAlias}.relPath NOT GLOB 'raw/.compact-archive/*'`,
  ].join(" AND ");
}

function vectorTemporalValiditySql(filesAlias: string): string {
  return [
    `(${filesAlias}.frontmatterValidFrom IS NULL OR ${filesAlias}.frontmatterValidFrom <= ?)`,
    `(${filesAlias}.frontmatterValidUntil IS NULL OR ${filesAlias}.frontmatterValidUntil >= ?)`,
  ].join(" AND ");
}

function vectorIdentitySql(
  options: Pick<VectorSearchOptions, "agentId" | "userId" | "identityMode">,
  filesAlias: string,
): { readonly sql: string; readonly params: string[] } {
  const requested: string[] = [];
  const params: string[] = [];
  if (options.agentId) {
    requested.push(`${filesAlias}.frontmatterAgentId = ?`);
    params.push(options.agentId);
  }
  if (options.userId) {
    requested.push(`${filesAlias}.frontmatterUserId = ?`);
    params.push(options.userId);
  }
  if (requested.length === 0) return { sql: "1 = 1", params };

  if (options.identityMode === "strict") {
    return {
      sql: [
        `(${filesAlias}.frontmatterAgentId IS NOT NULL OR ${filesAlias}.frontmatterUserId IS NOT NULL)`,
        ...requested,
      ].join(" AND "),
      params,
    };
  }
  return {
    sql: `((${filesAlias}.frontmatterAgentId IS NULL AND ${filesAlias}.frontmatterUserId IS NULL) OR (${requested.join(" AND ")}))`,
    params,
  };
}
