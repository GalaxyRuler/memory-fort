import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as BetterSqlite3Constructor;
const sqliteVec = require("sqlite-vec") as SqliteVecModule;

const FTS5_PROBE_TABLE = "capability_fts5_probe";
const VEC_PROBE_TABLE = "capability_vec_probe";
const EXPECTED_FIRST_TITLE = "expected electron fts5";
const EXPECTED_NEAREST_ROWID = 1;
const VEC_QUERY = JSON.stringify([1.0, 0.1, 0.0]);

export type CapabilityStep =
  | "open"
  | "wal"
  | "fts5-table"
  | "fts5-seed"
  | "fts5-query"
  | "fts5-ranking"
  | "vec-resolve"
  | "vec-load"
  | "vec-knn"
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
  loadExtension(path: string, entrypoint?: string): void;
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

interface SqliteVecModule {
  getLoadablePath(): string;
}

interface Fts5ProbeRow {
  readonly title: string;
  readonly rank: number;
}

interface VecKnnProbeRow {
  readonly rowid: number | bigint;
  readonly distance: number;
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
}

/**
 * Resolve the platform/arch-correct sqlite-vec loadable extension.
 *
 * Keep this as the single chokepoint for Phase 0b.3's future win-arm64
 * vendored vec0.dll path; official sqlite-vec npm packages do not ship one.
 */
export function resolveSqliteVecBinary(): string {
  try {
    const vendoredBinary = resolveVendoredSqliteVecBinary();
    if (vendoredBinary) return validateSqliteVecBinaryPath(vendoredBinary);

    return validateSqliteVecBinaryPath(sqliteVec.getLoadablePath());
  } catch (error) {
    throw new CapabilityError(
      "vec-resolve",
      `Failed to resolve sqlite-vec loadable extension for ${process.platform}-${process.arch}`,
      error
    );
  }
}

/** Load sqlite-vec into an open better-sqlite3 database. */
export function loadSqliteVec(db: CapabilityDb): void {
  const binaryPath = resolveSqliteVecBinary();
  try {
    db.database.loadExtension(binaryPath);
  } catch (error) {
    throw new CapabilityError("vec-load", `Failed to load sqlite-vec extension at ${binaryPath}`, error);
  }
}

/**
 * Create a vec0 table, seed known vectors, and verify exact nearest-neighbour ordering.
 * Throws CapabilityError when vec0 is unavailable or KNN semantics regress.
 */
export function assertVec0Knn(db: CapabilityDb): void {
  try {
    db.database.exec(`
      DROP TABLE IF EXISTS temp.${VEC_PROBE_TABLE};
      CREATE VIRTUAL TABLE temp.${VEC_PROBE_TABLE} USING vec0(embedding float[3]);
    `);

    const insert = db.database.prepare<[bigint, string]>(
      `INSERT INTO temp.${VEC_PROBE_TABLE} (rowid, embedding) VALUES (?, ?)`
    );
    insert.run(1n, JSON.stringify([1.0, 0.0, 0.0]));
    insert.run(2n, JSON.stringify([0.0, 1.0, 0.0]));

    const row = db.database
      .prepare<[string], VecKnnProbeRow>(`
        SELECT rowid, distance
        FROM temp.${VEC_PROBE_TABLE}
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT 1
      `)
      .get(VEC_QUERY);

    if (!row) {
      throw new Error(`sqlite-vec KNN query returned no rows for ${VEC_QUERY}`);
    }

    if (Number(row.rowid) !== EXPECTED_NEAREST_ROWID) {
      throw new Error(
        `sqlite-vec KNN returned rowid ${String(row.rowid)} first; expected ${EXPECTED_NEAREST_ROWID}`
      );
    }
  } catch (error) {
    throw new CapabilityError("vec-knn", "sqlite-vec exact KNN probe failed", error);
  }
}

export function closeCapabilityDb(db: CapabilityDb): void {
  try {
    db.database.close();
  } catch (error) {
    throw new CapabilityError("close", `Failed to close capability database at ${db.path}`, error);
  }
}

function resolveVendoredSqliteVecBinary(): string | null {
  if (process.platform === "win32" && process.arch === "arm64") {
    return null;
  }
  return null;
}

function validateSqliteVecBinaryPath(binaryPath: string): string {
  if (!isAbsolute(binaryPath)) {
    throw new Error(`sqlite-vec resolved a non-absolute loadable extension path: ${binaryPath}`);
  }

  if (!existsSync(binaryPath)) {
    throw new Error(`sqlite-vec loadable extension does not exist: ${binaryPath}`);
  }

  return binaryPath;
}
