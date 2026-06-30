import type { IndexDb } from "./db.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const FTS_OPERATOR_TERMS = new Set(["AND", "OR", "NOT", "NEAR"]);

export interface LexicalSearchOptions {
  readonly limit?: number;
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
  readonly score: number;
}

type LexicalSearchRow = LexicalSearchResult;

export function lexicalSearch(
  indexDb: IndexDb,
  query: string,
  options: LexicalSearchOptions = {},
): LexicalSearchResult[] {
  const matchQuery = toSimpleFtsQuery(query);
  if (!matchQuery) return [];

  try {
    return indexDb.database
      .prepare<[string, number], LexicalSearchRow>(`
        WITH ranked AS (
          SELECT rowid, bm25(chunks_fts) AS score
          FROM chunks_fts
          WHERE chunks_fts MATCH ?
          ORDER BY score ASC, rowid ASC
          LIMIT ?
        )
        SELECT
          chunks.rowid AS rowid,
          chunks.chunkId AS chunkId,
          chunks.relPath AS relPath,
          chunks.ordinal AS ordinal,
          chunks.headingPath AS headingPath,
          chunks.byteStart AS byteStart,
          chunks.byteEnd AS byteEnd,
          chunks.text AS text,
          ranked.score AS score
        FROM ranked
        JOIN chunks ON chunks.rowid = ranked.rowid
        ORDER BY ranked.score ASC, ranked.rowid ASC
      `)
      .all(matchQuery, clampLimit(options.limit));
  } catch (error) {
    if (isFtsMatchError(error)) return [];
    throw error;
  }
}

function toSimpleFtsQuery(query: string): string | null {
  const normalized = query.normalize("NFKC");
  const withoutNearDistance = normalized.replace(/\bNEAR\s*\/\s*\d+\b/giu, "NEAR");
  const withoutColumnFilters = withoutNearDistance.replace(
    /(^|[^\p{L}\p{N}_])[\p{L}\p{N}_]+\s*:\s*(?=[\p{L}\p{N}_])/gu,
    "$1",
  );
  const terms = (withoutColumnFilters.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
    (term) => !FTS_OPERATOR_TERMS.has(term.toUpperCase()),
  );
  if (terms.length === 0) return null;
  // Simple user search intentionally requires every surviving term; raw FTS5 syntax is not exposed here.
  return terms.map((term) => `"${term}"`).join(" AND ");
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  const integer = Math.trunc(limit);
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, integer));
}

function isFtsMatchError(error: unknown): boolean {
  return error instanceof Error && /fts5|match|syntax|malformed|unterminated/i.test(error.message);
}
