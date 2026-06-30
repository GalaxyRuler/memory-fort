import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as BetterSqlite3Constructor;

const SCHEMA_VERSION = "1";
const TOKENIZER = "unicode61 remove_diacritics 2";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

// Used when the compiled Electron bundle cannot read sibling .sql assets.
const INIT_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS files (
  relPath TEXT PRIMARY KEY,
  kind TEXT,
  sizeBytes INTEGER,
  mtimeMs INTEGER,
  contentHash TEXT,
  generation INTEGER,
  lastSeenRunId INTEGER,
  errorState TEXT,
  indexedAt INTEGER,
  lastErrorAt INTEGER
);

CREATE TABLE IF NOT EXISTS chunks (
  rowid INTEGER PRIMARY KEY,
  chunkId TEXT UNIQUE NOT NULL,
  relPath TEXT NOT NULL REFERENCES files(relPath) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  headingPath TEXT,
  byteStart INTEGER NOT NULL,
  byteEnd INTEGER NOT NULL,
  text TEXT NOT NULL,
  textHash TEXT NOT NULL,
  generation INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  headingPath,
  relPath UNINDEXED,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, headingPath, relPath)
  VALUES (new.rowid, new.text, new.headingPath, new.relPath);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, headingPath, relPath)
  VALUES ('delete', old.rowid, old.text, old.headingPath, old.relPath);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, headingPath, relPath)
  VALUES ('delete', old.rowid, old.text, old.headingPath, old.relPath);
  INSERT INTO chunks_fts(rowid, text, headingPath, relPath)
  VALUES (new.rowid, new.text, new.headingPath, new.relPath);
END;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO meta(key, value) VALUES ('tokenizer', 'unicode61 remove_diacritics 2')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE INDEX IF NOT EXISTS idx_chunks_relPath ON chunks(relPath);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_relPath_ordinal ON chunks(relPath, ordinal);
CREATE INDEX IF NOT EXISTS idx_chunks_generation ON chunks(generation);
CREATE INDEX IF NOT EXISTS idx_files_generation ON files(generation);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(contentHash);`;

export interface IndexDb {
  readonly path: string;
  readonly database: SqliteDatabase;
  close(): void;
  integrityCheck(): void;
  rebuildFts(): void;
}

export interface OpenIndexDbOptions {
  readonly path?: string;
  readonly vaultRoot?: string;
  readonly appDataDir?: string;
  readonly busyTimeoutMs?: number;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  pragma(sql: string, options?: { readonly simple?: boolean }): unknown;
  prepare<Params extends unknown[] = unknown[], Row = unknown>(sql: string): SqliteStatement<Params, Row>;
  close(): void;
}

export interface SqliteStatement<Params extends unknown[] = unknown[], Row = unknown> {
  run(...params: Params): unknown;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

interface BetterSqlite3Constructor {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): SqliteDatabase;
}

interface MetaRow {
  readonly value: string | null;
}

interface NameRow {
  readonly name: string;
}

export function openIndexDb(pathOrOptions?: string | OpenIndexDbOptions): IndexDb {
  const options = normalizeOptions(pathOrOptions);
  mkdirSync(dirname(options.path), { recursive: true });
  try {
    return openInitializedIndexDb(options.path, options.busyTimeoutMs);
  } catch (error) {
    if (!isRecoverableOpenError(error)) throw error;
    deleteIndexDbFiles(options.path);
    return openInitializedIndexDb(options.path, options.busyTimeoutMs);
  }
}

export function openReadOnlyIndexDb(pathOrOptions?: string | OpenIndexDbOptions): IndexDb {
  const options = normalizeOptions(pathOrOptions);
  const database = new BetterSqlite3(options.path, { readonly: true, fileMustExist: true });

  try {
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
    assertSchema(database);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the open/schema failure.
    }
    throw error;
  }

  return {
    path: options.path,
    database,
    close: () => database.close(),
    integrityCheck: () => {
      // A read-only search connection must never issue the FTS integrity-check
      // maintenance command because that command writes through the virtual table.
    },
    rebuildFts: () => {
      throw new Error("Cannot rebuild FTS from a read-only index connection");
    },
  };
}

function openInitializedIndexDb(path: string, busyTimeoutMs: number): IndexDb {
  const database = new BetterSqlite3(path);

  try {
    const journalMode = database.pragma("journal_mode = WAL", { simple: true });
    if (String(journalMode).toLowerCase() !== "wal") {
      throw new Error(`Failed to enable WAL for index database at ${path}; got ${String(journalMode)}`);
    }
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    migrate(database);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the open/migration failure.
    }
    throw error;
  }

  return {
    path,
    database,
    close: () => database.close(),
    integrityCheck: () => {
      database.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)");
    },
    rebuildFts: () => {
      database.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    },
  };
}

export function resolveIndexDbPath(options: Omit<OpenIndexDbOptions, "path" | "busyTimeoutMs"> = {}): string {
  const override = process.env["MEMORY_INDEX_DB_PATH"];
  if (override) return resolve(override);

  const vaultRoot = resolve(options.vaultRoot ?? process.env["MEMORY_ROOT"] ?? join(homedir(), ".memory"));
  const vaultRootHash = createHash("sha256").update(vaultRoot).digest("hex");
  return join(resolveAppDataDir(options.appDataDir), "Memory Fort", "indexes", vaultRootHash, "index.db");
}

function normalizeOptions(pathOrOptions?: string | OpenIndexDbOptions): Required<Pick<OpenIndexDbOptions, "path" | "busyTimeoutMs">> {
  if (typeof pathOrOptions === "string") {
    return { path: resolve(pathOrOptions), busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS };
  }
  if (pathOrOptions?.path) {
    return {
      path: resolve(pathOrOptions.path),
      busyTimeoutMs: pathOrOptions.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    };
  }
  return {
    path: resolveIndexDbPath(pathOrOptions),
    busyTimeoutMs: pathOrOptions?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  };
}

function resolveAppDataDir(override?: string): string {
  if (override) return resolve(override);
  if (platform() === "win32") {
    return resolve(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"));
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return resolve(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"));
}

function migrate(database: SqliteDatabase): void {
  const schemaVersion = readMeta(database, "schemaVersion");
  if (schemaVersion === SCHEMA_VERSION) {
    assertSchema(database);
    return;
  }

  if (schemaVersion !== null) {
    throw new IndexSchemaMismatchError(`Index schema mismatch: expected ${SCHEMA_VERSION}, found ${schemaVersion}`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(loadInitMigrationSql());
    database
      .prepare<[string]>(
        "INSERT INTO meta(key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
  assertSchema(database);
}

function assertSchema(database: SqliteDatabase): void {
  const tokenizer = readMeta(database, "tokenizer");
  if (tokenizer !== TOKENIZER) {
    throw new IndexSchemaMismatchError(`Index tokenizer mismatch: expected ${TOKENIZER}, found ${String(tokenizer)}`);
  }
  assertSchemaObjects(database, "table", ["chunks", "chunks_fts", "files", "meta"]);
  assertSchemaObjects(database, "trigger", ["chunks_ad", "chunks_ai", "chunks_au"]);
  assertSchemaObjects(database, "index", [
    "idx_chunks_generation",
    "idx_chunks_relPath",
    "idx_chunks_relPath_ordinal",
    "idx_files_generation",
    "idx_files_hash",
  ]);
}

function readMeta(database: SqliteDatabase, key: string): string | null {
  try {
    return database.prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch (error) {
    if (isMissingMetaTableError(error)) return null;
    throw error;
  }
}

function isMissingMetaTableError(error: unknown): boolean {
  return error instanceof Error && /no such table: meta/i.test(error.message);
}

function assertSchemaObjects(database: SqliteDatabase, type: "index" | "table" | "trigger", names: readonly string[]): void {
  const rows = database
    .prepare<[string], NameRow>("SELECT name FROM sqlite_master WHERE type = ?")
    .all(type);
  const existing = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !existing.has(name));
  if (missing.length > 0) {
    throw new IndexSchemaMismatchError(`Index schema is missing ${type} object(s): ${missing.join(", ")}`);
  }
}

function loadInitMigrationSql(): string {
  try {
    return readFileSync(new URL("./migrations/001_init.sql", import.meta.url), "utf8");
  } catch {
    return INIT_MIGRATION_SQL;
  }
}

class IndexSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexSchemaMismatchError";
  }
}

function isRecoverableOpenError(error: unknown): boolean {
  if (error instanceof IndexSchemaMismatchError) return true;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB")) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return /file is not a database|database disk image is malformed|malformed database schema/i.test(error.message);
}

export function deleteIndexDbFiles(path: string): void {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) rmSync(candidate, { force: true });
  }
}
