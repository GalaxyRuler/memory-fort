import type { IndexDb } from "./db.js";
import type { SearchDocument, SearchScope } from "../retrieval/corpus.js";
import { canonicalizeAsOf } from "../retrieval/temporal-filter.js";
import { classifySearchKind, searchScopeSql } from "../search/kind.js";
import { scoreByMetadata } from "../retrieval/metadata-score.js";
import {
  KNOWN_LIFECYCLE_STAGES,
  KNOWN_VALIDATION_STATES,
  type ConfidenceVector,
  type Frontmatter,
  type LifecycleStage,
  type ValidationState,
} from "../storage/frontmatter.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DOC_CANDIDATE_MULTIPLIER = 20;
const MAX_DOC_CANDIDATE_LIMIT = 2_000;
const PATH_MATCH_SCORE_BONUS = 0.5;
const MIN_METADATA_SCORE = 0.01;
const FTS_OPERATOR_TERMS = new Set(["AND", "OR", "NOT", "NEAR"]);
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
const PATH_CANDIDATE_STOPWORDS = new Set([
  "about",
  "backup",
  "concept",
  "concepts",
  "decision",
  "decisions",
  "does",
  "issue",
  "issues",
  "lesson",
  "lessons",
  "note",
  "only",
  "page",
  "pages",
  "project",
  "projects",
  "raw",
  "reference",
  "references",
  "related",
  "that",
  "thread",
  "threads",
  "tool",
  "tools",
  "uses",
  "what",
  "where",
  "which",
  "wiki",
]);

export interface LexicalSearchOptions {
  readonly limit?: number;
  readonly scope?: SearchScope;
  readonly includeArchived?: boolean;
  readonly asOf?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly identityMode?: "inclusive" | "strict";
}

export interface LexicalSearchResult {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly text: string;
  readonly kind?: SearchDocument["kind"];
  readonly score: number;
}

interface LexicalSearchRow extends Omit<LexicalSearchResult, "kind"> {
  readonly bm25Score: number;
  readonly scopeRank: number;
  readonly kind: string | null;
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
  readonly frontmatterStatus: string | null;
  readonly frontmatterLifecycle: string | null;
  readonly frontmatterConfidence: number | null;
  readonly frontmatterConfidenceJson: string | null;
  readonly frontmatterValidation: string | null;
  readonly frontmatterCreated: string | null;
  readonly frontmatterUpdated: string | null;
  readonly frontmatterObservedAt: string | null;
}

interface RankedLexicalSearchRow {
  readonly row: LexicalSearchRow;
  readonly pathMatches: number;
  readonly score: number;
  readonly baseRank: number;
  readonly metadataScore: number;
}

export function lexicalSearch(
  indexDb: IndexDb,
  query: string,
  options: LexicalSearchOptions = {},
): LexicalSearchResult[] {
  const terms = toSimpleFtsTerms(query);
  const matchQuery = toSimpleFtsQuery(terms);
  if (!matchQuery) return [];
  const limit = clampLimit(options.limit);
  const candidateLimit = docCandidateLimit(limit);
  const asOf = canonicalizeAsOf(options.asOf);
  const scopeFilter = searchScopeSql(options.scope ?? "all", "files");
  const archiveFilter = options.includeArchived === true ? "1 = 1" : activeDocumentSql("files");
  const temporalFilter = asOf ? temporalValiditySql("files") : "1 = 1";
  const temporalParams = asOf ? [asOf, asOf] : [];
  const identityFilter = identitySql(options, "files");

  try {
    const rows = indexDb.database
      .prepare<unknown[], LexicalSearchRow>(`
        WITH matched AS (
          SELECT chunks_fts.rowid AS rowid, bm25(chunks_fts) AS bm25Score
          FROM chunks_fts
          JOIN chunks ON chunks.rowid = chunks_fts.rowid
          JOIN files ON files.relPath = chunks.relPath
          WHERE chunks_fts MATCH ?
            AND ${scopeFilter}
            AND ${archiveFilter}
            AND ${temporalFilter}
            AND ${identityFilter.sql}
          ORDER BY bm25Score ASC, chunks_fts.rowid ASC
          LIMIT ?
        ),
        ranked AS (
          SELECT
            chunks.rowid AS rowid,
            chunks.chunkId AS chunkId,
            chunks.relPath AS relPath,
            chunks.ordinal AS ordinal,
            chunks.headingPath AS headingPath,
            chunks.byteStart AS byteStart,
            chunks.byteEnd AS byteEnd,
            chunks.text AS text,
            matched.bm25Score AS bm25Score,
            files.kind AS kind,
            files.sizeBytes AS sizeBytes,
            files.mtimeMs AS mtimeMs,
            files.frontmatterStatus AS frontmatterStatus,
            files.frontmatterLifecycle AS frontmatterLifecycle,
            files.frontmatterConfidence AS frontmatterConfidence,
            files.frontmatterConfidenceJson AS frontmatterConfidenceJson,
            files.frontmatterValidation AS frontmatterValidation,
            files.frontmatterCreated AS frontmatterCreated,
            files.frontmatterUpdated AS frontmatterUpdated,
            files.frontmatterObservedAt AS frontmatterObservedAt,
            CASE
              WHEN chunks.relPath GLOB 'wiki/archive/*' THEN 3
              WHEN chunks.relPath GLOB 'raw/*' THEN 2
              WHEN chunks.relPath GLOB 'wiki/compile-proposed/*' THEN 1
              ELSE 0
            END AS scopeRank,
            matched.bm25Score + CASE
              WHEN chunks.relPath GLOB 'wiki/archive/*' THEN 3
              WHEN chunks.relPath GLOB 'raw/*' THEN 2
              WHEN chunks.relPath GLOB 'wiki/compile-proposed/*' THEN 1
              ELSE 0
            END AS score,
            row_number() OVER (
              PARTITION BY chunks.relPath
              ORDER BY matched.bm25Score ASC, chunks.rowid ASC
            ) AS docRank
          FROM matched
          JOIN chunks ON chunks.rowid = matched.rowid
          JOIN files ON files.relPath = chunks.relPath
        )
        SELECT
          rowid,
          chunkId,
          relPath,
          ordinal,
          headingPath,
          byteStart,
          byteEnd,
          text,
          bm25Score,
          kind,
          sizeBytes,
          mtimeMs,
          frontmatterStatus,
          frontmatterLifecycle,
          frontmatterConfidence,
          frontmatterConfidenceJson,
          frontmatterValidation,
          frontmatterCreated,
          frontmatterUpdated,
          frontmatterObservedAt,
          scopeRank,
          score
        FROM ranked
        WHERE docRank = 1
        ORDER BY scopeRank ASC, score ASC, bm25Score ASC, relPath ASC, rowid ASC
          LIMIT ?
      `)
      .all(matchQuery, ...temporalParams, ...identityFilter.params, candidateLimit, candidateLimit);

    return rankRows(mergeRowsByRelPath(rows, pathCandidateRows(indexDb, terms, candidateLimit, { ...options, asOf })), terms)
      .slice(0, limit)
      .map(({ row, score }) => ({
        rowid: row.rowid,
        chunkId: row.chunkId,
        relPath: row.relPath,
        ordinal: row.ordinal,
        headingPath: row.headingPath,
        byteStart: row.byteStart,
        byteEnd: row.byteEnd,
        text: row.text,
        kind: searchKindFromIndexKind(row.kind, row.relPath),
        score,
      }));
  } catch (error) {
    if (isFtsMatchError(error)) return [];
    throw error;
  }
}

function toSimpleFtsTerms(query: string): string[] {
  const normalized = query.normalize("NFKC");
  const withoutNearDistance = normalized.replace(/\bNEAR\s*\/\s*\d+\b/giu, "NEAR");
  const withoutColumnFilters = withoutNearDistance.replace(
    /(^|[^\p{L}\p{N}_])[\p{L}\p{N}_]+\s*:\s*(?=[\p{L}\p{N}_])/gu,
    "$1",
  );
  const terms = (withoutColumnFilters.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (term) => !FTS_OPERATOR_TERMS.has(term.toUpperCase()) && !LEXICAL_STOPWORDS.has(term.toLowerCase()),
  );
  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

function toSimpleFtsQuery(terms: readonly string[]): string | null {
  if (terms.length === 0) return null;
  // Relaxed matching keeps verbose natural-language labels from excluding concise curated pages.
  return terms.map((term) => `"${term}"`).join(" OR ");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  const integer = Math.trunc(limit);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, integer));
}

function docCandidateLimit(limit: number): number {
  return Math.min(MAX_DOC_CANDIDATE_LIMIT, Math.max(limit, limit * DOC_CANDIDATE_MULTIPLIER));
}

function pathCandidateRows(
  indexDb: IndexDb,
  terms: readonly string[],
  limit: number,
  options: LexicalSearchOptions,
): LexicalSearchRow[] {
  const pathTerms = pathCandidateTerms(terms);
  if (pathTerms.length === 0) return [];
  const conditions = pathTerms.map(() => "lower(files.relPath) LIKE ? ESCAPE '\\'").join(" OR ");
  const temporalParams = options.asOf ? [options.asOf, options.asOf] : [];
  const identityFilter = identitySql(options, "files");
  const archiveFilter = options.includeArchived === true ? "1 = 1" : activeDocumentSql("files");
  return indexDb.database
    .prepare<unknown[], LexicalSearchRow>(`
      WITH matched_files AS (
        SELECT relPath
        FROM files
        WHERE errorState IS NULL AND (${conditions})
          AND ${searchScopeSql(options.scope ?? "all", "files")}
          AND ${archiveFilter}
          AND ${options.asOf ? temporalValiditySql("files") : "1 = 1"}
          AND ${identityFilter.sql}
        ORDER BY
          CASE
            WHEN relPath GLOB 'wiki/archive/*' THEN 3
            WHEN relPath GLOB 'raw/*' THEN 2
            WHEN relPath GLOB 'wiki/compile-proposed/*' THEN 1
            ELSE 0
          END ASC,
          relPath ASC
        LIMIT ?
      ),
      ranked AS (
        SELECT
          chunks.rowid AS rowid,
          chunks.chunkId AS chunkId,
          chunks.relPath AS relPath,
          chunks.ordinal AS ordinal,
          chunks.headingPath AS headingPath,
          chunks.byteStart AS byteStart,
          chunks.byteEnd AS byteEnd,
          chunks.text AS text,
          0 AS bm25Score,
          files.kind AS kind,
          files.sizeBytes AS sizeBytes,
          files.mtimeMs AS mtimeMs,
          files.frontmatterStatus AS frontmatterStatus,
          files.frontmatterLifecycle AS frontmatterLifecycle,
          files.frontmatterConfidence AS frontmatterConfidence,
          files.frontmatterConfidenceJson AS frontmatterConfidenceJson,
          files.frontmatterValidation AS frontmatterValidation,
          files.frontmatterCreated AS frontmatterCreated,
          files.frontmatterUpdated AS frontmatterUpdated,
          files.frontmatterObservedAt AS frontmatterObservedAt,
          CASE
            WHEN chunks.relPath GLOB 'wiki/archive/*' THEN 3
            WHEN chunks.relPath GLOB 'raw/*' THEN 2
            WHEN chunks.relPath GLOB 'wiki/compile-proposed/*' THEN 1
            ELSE 0
          END AS scopeRank,
          CASE
            WHEN chunks.relPath GLOB 'wiki/archive/*' THEN 3
            WHEN chunks.relPath GLOB 'raw/*' THEN 2
            WHEN chunks.relPath GLOB 'wiki/compile-proposed/*' THEN 1
            ELSE 0
          END AS score,
          row_number() OVER (
            PARTITION BY chunks.relPath
            ORDER BY chunks.ordinal ASC, chunks.rowid ASC
          ) AS docRank
        FROM matched_files
        JOIN chunks ON chunks.relPath = matched_files.relPath
        JOIN files ON files.relPath = chunks.relPath
      )
      SELECT
        rowid,
        chunkId,
        relPath,
        ordinal,
        headingPath,
        byteStart,
        byteEnd,
        text,
        bm25Score,
        kind,
        sizeBytes,
        mtimeMs,
        frontmatterStatus,
        frontmatterLifecycle,
        frontmatterConfidence,
        frontmatterConfidenceJson,
        frontmatterValidation,
        frontmatterCreated,
        frontmatterUpdated,
        frontmatterObservedAt,
        scopeRank,
        score
      FROM ranked
      WHERE docRank = 1
    `)
    .all(...pathTerms.map(likePatternForTerm), ...temporalParams, ...identityFilter.params, limit);
}

function rankRows(rows: readonly LexicalSearchRow[], terms: readonly string[]): RankedLexicalSearchRow[] {
  const baseRanked = rows
    .map((row): RankedLexicalSearchRow => {
      const pathMatches = pathMatchCount(row.relPath, terms);
      return {
        row,
        pathMatches,
        score: row.score - pathMatches * PATH_MATCH_SCORE_BONUS,
        baseRank: 0,
        metadataScore: 1,
      };
    })
    .sort(
      (a, b) =>
        a.row.scopeRank - b.row.scopeRank ||
        a.score - b.score ||
        b.pathMatches - a.pathMatches ||
        a.row.bm25Score - b.row.bm25Score ||
        a.row.relPath.localeCompare(b.row.relPath) ||
        a.row.rowid - b.row.rowid,
    );
  const metadataByPath = new Map(
    scoreByMetadata(baseRanked.map((ranked) => searchDocumentFromRow(ranked.row))).map((metadata) => [
      metadata.path,
      metadata.score,
    ]),
  );
  return baseRanked
    .map((ranked, index): RankedLexicalSearchRow => {
      const baseRank = index + 1;
      const metadataScore = metadataByPath.get(ranked.row.relPath) ?? 1;
      return {
        ...ranked,
        baseRank,
        metadataScore,
        score: baseRank / Math.max(MIN_METADATA_SCORE, metadataScore),
      };
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.baseRank - b.baseRank ||
        b.metadataScore - a.metadataScore ||
        a.row.relPath.localeCompare(b.row.relPath) ||
        a.row.rowid - b.row.rowid,
    );
}

function mergeRowsByRelPath(
  primaryRows: readonly LexicalSearchRow[],
  fallbackRows: readonly LexicalSearchRow[],
): LexicalSearchRow[] {
  const byRelPath = new Map<string, LexicalSearchRow>();
  for (const row of primaryRows) byRelPath.set(row.relPath, row);
  for (const row of fallbackRows) {
    if (!byRelPath.has(row.relPath)) byRelPath.set(row.relPath, row);
  }
  return [...byRelPath.values()];
}

function pathCandidateTerms(terms: readonly string[]): string[] {
  return terms.filter((term) => term.length >= 3 && !PATH_CANDIDATE_STOPWORDS.has(term));
}

function pathMatchCount(relPath: string, terms: readonly string[]): number {
  const normalizedPath = relPath.toLowerCase();
  let count = 0;
  for (const term of pathCandidateTerms(terms)) {
    if (normalizedPath.includes(term)) count += 1;
  }
  return count;
}

function likePatternForTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

function searchDocumentFromRow(row: LexicalSearchRow): SearchDocument {
  const confidenceFull = confidenceFullFromRow(row);
  return {
    kind: searchKindFromIndexKind(row.kind, row.relPath),
    relPath: row.relPath,
    fullPath: row.relPath,
    title: titleFromPath(row.relPath),
    type: typeFromPath(row.relPath),
    status: row.frontmatterStatus ?? "active",
    cognitiveType: "semantic",
    confidence: row.frontmatterConfidence,
    ...(confidenceFull !== undefined ? { confidenceFull } : {}),
    lifecycle: readLifecycle(row.frontmatterLifecycle),
    tags: [],
    relations: {},
    source: "index",
    session: null,
    importedFrom: null,
    body: "",
    snippetSource: row.text,
    created: row.frontmatterCreated,
    observedAt: row.frontmatterObservedAt,
    updated: row.frontmatterUpdated,
    mtime: row.mtimeMs === null ? new Date(0).toISOString() : new Date(row.mtimeMs).toISOString(),
    sizeBytes: row.sizeBytes ?? 0,
  };
}

function confidenceFullFromRow(row: LexicalSearchRow): Frontmatter["confidence"] | undefined {
  const parsed = parseConfidenceJson(row.frontmatterConfidenceJson);
  if (parsed !== undefined) return parsed;
  if (row.frontmatterValidation && row.frontmatterConfidence !== null) {
    const validation = readValidation(row.frontmatterValidation);
    return validation
      ? { extraction: row.frontmatterConfidence, validation }
      : row.frontmatterConfidence;
  }
  return row.frontmatterConfidence ?? undefined;
}

function parseConfidenceJson(value: string | null): Frontmatter["confidence"] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
    if (isConfidenceVector(parsed)) return parsed;
  } catch {
    return undefined;
  }
  return undefined;
}

function isConfidenceVector(value: unknown): value is ConfidenceVector {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLifecycle(value: string | null): LifecycleStage | null {
  return KNOWN_LIFECYCLE_STAGES.includes(value as never) ? value as LifecycleStage : null;
}

function readValidation(value: string | null): ValidationState | null {
  return KNOWN_VALIDATION_STATES.includes(value as never) ? value as ValidationState : null;
}

function searchKindFromIndexKind(kind: string | null, relPath: string): SearchDocument["kind"] {
  return classifySearchKind({ relPath, kind });
}

function titleFromPath(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  return basename.replace(/\.md$/iu, "").replace(/[-_]+/gu, " ");
}

function typeFromPath(relPath: string): string {
  if (relPath.startsWith("raw/")) return "raw-session";
  return relPath.split("/")[1] ?? "wiki";
}


function activeDocumentSql(filesAlias: string): string {
  return [
    `coalesce(${filesAlias}.frontmatterStatus, '') NOT IN ('archived', 'superseded')`,
    `coalesce(${filesAlias}.frontmatterLifecycle, '') <> 'archived'`,
    `${filesAlias}.relPath NOT GLOB 'wiki/archive/*'`,
    `${filesAlias}.relPath NOT GLOB 'wiki/.archive/*'`,
    `${filesAlias}.relPath NOT GLOB 'raw/.compact-archive/*'`,
  ].join(" AND ");
}

function temporalValiditySql(filesAlias: string): string {
  return [
    `(${filesAlias}.frontmatterValidFrom IS NULL OR ${filesAlias}.frontmatterValidFrom <= ?)`,
    `(${filesAlias}.frontmatterValidUntil IS NULL OR ${filesAlias}.frontmatterValidUntil >= ?)`,
  ].join(" AND ");
}

function identitySql(
  options: Pick<LexicalSearchOptions, "agentId" | "userId" | "identityMode">,
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

function isFtsMatchError(error: unknown): boolean {
  return error instanceof Error && /fts5|match|syntax|malformed|unterminated/i.test(error.message);
}
