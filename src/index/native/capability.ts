import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as BetterSqlite3Constructor;

const FTS5_PROBE_TABLE = "capability_fts5_probe";
const EXPECTED_FIRST_TITLE = "expected electron fts5";

export type CapabilityStep =
  | "open"
  | "wal"
  | "fts5-table"
  | "fts5-seed"
  | "fts5-query"
  | "fts5-ranking"
  | "close";

export class CapabilityError extends Error {
  readonly step: CapabilityStep;

  constructor(step: CapabilityStep, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CapabilityError";
    this.step = step;
  }
}

export interface CapabilityDb {
  readonly path: string;
  readonly database: CapabilitySqliteDatabase;
}

export interface CapabilitySqliteDatabase {
  exec(sql: string): void;
  pragma(sql: string, options?: { readonly simple?: boolean }): unknown;
  prepare<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string
  ): CapabilitySqliteStatement<Params, Row>;
  close(): void;
}

export interface CapabilitySqliteStatement<Params extends unknown[] = unknown[], Row = unknown> {
  run(...params: Params): unknown;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

export interface Fts5ProbeOptions {
  readonly matchQuery?: string;
  readonly expectedFirstTitle?: string;
}

interface BetterSqlite3Constructor {
  new (path: string): CapabilitySqliteDatabase;
}

interface Fts5ProbeRow {
  readonly title: string;
  readonly rank: number;
}

/** Open a better-sqlite3 DB at `path` (':memory:' or a file). WAL for file DBs. Typed throw on failure. */
export function openCapabilityDb(path: string): CapabilityDb {
  let database: CapabilitySqliteDatabase;
  try {
    database = new BetterSqlite3(path);
  } catch (error) {
    throw new CapabilityError("open", `Failed to open capability database at ${path}`, error);
  }

  if (path !== ":memory:") {
    try {
      database.pragma("journal_mode = WAL");
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the WAL failure as the actionable capability error.
      }
      throw new CapabilityError("wal", `Failed to enable WAL for capability database at ${path}`, error);
    }
  }

  return { path, database };
}

/**
 * Create an FTS5 table, insert rows, and verify bm25()-ranked MATCH ordering.
 * Throws CapabilityError when FTS5 is missing or the probe query/ranking fails.
 */
export function assertFts5(db: CapabilityDb, options: Fts5ProbeOptions = {}): void {
  const matchQuery = options.matchQuery ?? "electron fts5";
  const expectedFirstTitle = options.expectedFirstTitle ?? EXPECTED_FIRST_TITLE;

  try {
    db.database.exec(`
      DROP TABLE IF EXISTS temp.${FTS5_PROBE_TABLE};
      CREATE VIRTUAL TABLE temp.${FTS5_PROBE_TABLE} USING fts5(title, body);
    `);
  } catch (error) {
    throw new CapabilityError("fts5-table", "FTS5 is unavailable: failed to create probe virtual table", error);
  }

  try {
    const insert = db.database.prepare<[string, string]>(
      `INSERT INTO temp.${FTS5_PROBE_TABLE} (title, body) VALUES (?, ?)`
    );
    insert.run(EXPECTED_FIRST_TITLE, "electron electron electron fts5 fts5 native sqlite");
    insert.run("secondary electron sqlite", "electron native sqlite");
    insert.run("unrelated memory note", "dashboard vault search");
  } catch (error) {
    throw new CapabilityError("fts5-seed", "FTS5 probe failed while inserting rows", error);
  }

  let rows: Fts5ProbeRow[];
  try {
    rows = db.database
      .prepare<[string], Fts5ProbeRow>(`
        SELECT title, bm25(${FTS5_PROBE_TABLE}) AS rank
        FROM temp.${FTS5_PROBE_TABLE}
        WHERE ${FTS5_PROBE_TABLE} MATCH ?
        ORDER BY rank ASC
        LIMIT 3
      `)
      .all(matchQuery);
  } catch (error) {
    throw new CapabilityError(
      "fts5-query",
      `FTS5 MATCH query failed for probe query ${JSON.stringify(matchQuery)}`,
      error
    );
  }

  if (rows.length === 0) {
    throw new CapabilityError("fts5-ranking", `FTS5 MATCH query returned no rows for ${JSON.stringify(matchQuery)}`);
  }

  if (rows[0]?.title !== expectedFirstTitle) {
    const rankedTitles = rows.map((row) => `${row.title}:${row.rank}`).join(", ");
    throw new CapabilityError(
      "fts5-ranking",
      `FTS5 bm25 ranking returned ${JSON.stringify(rows[0]?.title)} first; expected ${JSON.stringify(
        expectedFirstTitle
      )}. Rows: ${rankedTitles}`
    );
  }

  // TODO(0b.2): resolveSqliteVecBinary / loadSqliteVec / assertVec0Knn.
}

export function closeCapabilityDb(db: CapabilityDb): void {
  try {
    db.database.close();
  } catch (error) {
    throw new CapabilityError("close", `Failed to close capability database at ${db.path}`, error);
  }
}
