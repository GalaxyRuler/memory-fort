import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { chunkMarkdown, type ChunkMarkdownOptions } from "./chunk.js";
import type { IndexDb, SqliteDatabase } from "./db.js";

export interface ReconcileIndexResult {
  readonly filesIndexed: number;
  readonly filesTombstoned: number;
  readonly chunks: number;
  readonly filesSkipped: number;
}

export type ReconcileIndexEvent =
  | { readonly type: "runStarted"; readonly runId: number }
  | { readonly type: "fileDiscovered"; readonly runId: number; readonly relPath: string }
  | { readonly type: "fileChunksDeleted"; readonly runId: number; readonly relPath: string };

export interface ReconcileIndexOptions {
  readonly chunkOptions?: ChunkMarkdownOptions;
  readonly maxChunksPerFile?: number;
  readonly maxFileBytes?: number;
  readonly onEvent?: (event: ReconcileIndexEvent) => void;
}

const DEFAULT_MAX_CHUNKS_PER_FILE = 50_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

interface VaultFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly kind: "raw" | "wiki";
}

interface FileStatRow {
  readonly sizeBytes: number | null;
  readonly mtimeMs: number | null;
  readonly contentHash: string | null;
  readonly generation: number | null;
  readonly errorState: string | null;
}

interface MaxRunIdRow {
  readonly runId: number | null;
}

interface RelPathRow {
  readonly relPath: string;
}

export async function reconcileIndex(
  indexDb: IndexDb,
  vaultRoot: string,
  options: ReconcileIndexOptions = {},
): Promise<ReconcileIndexResult> {
  const db = indexDb.database;
  const runId = startRun(db);
  emit(options, { type: "runStarted", runId });
  const maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
  const maxChunksPerFile = positiveInteger(options.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE, "maxChunksPerFile");
  let filesIndexed = 0;
  let filesSkipped = 0;
  let chunks = 0;

  for await (const file of walkVaultMarkdown(vaultRoot)) {
    emit(options, { type: "fileDiscovered", runId, relPath: file.relPath });
    const stats = await stat(file.absPath);
    const mtimeMs = Math.trunc(stats.mtimeMs);
    const existing = db
      .prepare<[string], FileStatRow>(
        "SELECT sizeBytes, mtimeMs, contentHash, generation, errorState FROM files WHERE relPath = ?",
      )
      .get(file.relPath);
    if (stats.size > maxFileBytes) {
      markFileSkipped(db, {
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: stats.size,
        mtimeMs,
        generation: existing?.generation ?? 0,
        runId,
        errorState: "too-large",
      });
      filesSkipped += 1;
      continue;
    }
    if (existing?.contentHash && !existing.errorState && existing.sizeBytes === stats.size && existing.mtimeMs === mtimeMs) {
      markFileSeen(db, file.relPath, runId);
      continue;
    }

    const contentHash = await hashFile(file.absPath);
    if (existing?.contentHash === contentHash && !existing.errorState) {
      markFileUnchanged(db, {
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: stats.size,
        mtimeMs,
        runId,
      });
      continue;
    }

    const indexedContent = await readTextFileWithHash(file.absPath);
    if (existing?.contentHash === indexedContent.contentHash && !existing.errorState) {
      markFileUnchanged(db, {
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: stats.size,
        mtimeMs,
        runId,
      });
      continue;
    }

    const generation = (existing?.generation ?? 0) + 1;
    const fileChunks = chunkMarkdown(indexedContent.text, options.chunkOptions);
    if (fileChunks.length > maxChunksPerFile) {
      markFileSkipped(db, {
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: stats.size,
        mtimeMs,
        generation: existing?.generation ?? 0,
        runId,
        errorState: "too-many-chunks",
      });
      filesSkipped += 1;
      continue;
    }

    writeIndexedFile(
      db,
      {
        relPath: file.relPath,
        kind: file.kind,
        sizeBytes: stats.size,
        mtimeMs,
        contentHash: indexedContent.contentHash,
        generation,
        runId,
        chunks: fileChunks,
      },
      options,
    );

    filesIndexed += 1;
    chunks += fileChunks.length;
  }

  markRunComplete(db, runId);
  const filesTombstoned = tombstoneMissingFiles(db, runId);
  markRunFinished(db, runId);
  return { filesIndexed, filesTombstoned, chunks, filesSkipped };
}

function emit(options: ReconcileIndexOptions, event: ReconcileIndexEvent): void {
  options.onEvent?.(event);
}

function markFileSeen(db: SqliteDatabase, relPath: string, runId: number): void {
  db.prepare<[number, string]>("UPDATE files SET lastSeenRunId = ? WHERE relPath = ?").run(runId, relPath);
}

function markFileUnchanged(
  db: SqliteDatabase,
  input: {
    readonly relPath: string;
    readonly kind: "raw" | "wiki";
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly runId: number;
  },
): void {
  db.prepare<[string, number, number, number, string]>(
    `UPDATE files
     SET kind = ?, sizeBytes = ?, mtimeMs = ?, lastSeenRunId = ?
     WHERE relPath = ?`,
  ).run(input.kind, input.sizeBytes, input.mtimeMs, input.runId, input.relPath);
}

function markFileSkipped(
  db: SqliteDatabase,
  input: {
    readonly relPath: string;
    readonly kind: "raw" | "wiki";
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly generation: number;
    readonly runId: number;
    readonly errorState: "too-large" | "too-many-chunks";
  },
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare<[string, string, number, number, null, number, number, string, null, number]>(
      `INSERT INTO files(
         relPath, kind, sizeBytes, mtimeMs, contentHash, generation, lastSeenRunId, errorState, indexedAt, lastErrorAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(relPath) DO UPDATE SET
         kind = excluded.kind,
         sizeBytes = excluded.sizeBytes,
         mtimeMs = excluded.mtimeMs,
         contentHash = NULL,
         generation = excluded.generation,
         lastSeenRunId = excluded.lastSeenRunId,
         errorState = excluded.errorState,
         indexedAt = NULL,
         lastErrorAt = excluded.lastErrorAt`,
    ).run(
      input.relPath,
      input.kind,
      input.sizeBytes,
      input.mtimeMs,
      null,
      input.generation,
      input.runId,
      input.errorState,
      null,
      Date.now(),
    );
    db.prepare<[string]>("DELETE FROM chunks WHERE relPath = ?").run(input.relPath);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original skip failure.
    }
    throw error;
  }
}

async function* walkVaultMarkdown(vaultRoot: string): AsyncGenerator<VaultFile> {
  const root = resolve(vaultRoot);
  for (const kind of ["raw", "wiki"] as const) {
    const dir = resolve(root, kind);
    yield* walkDirectory(root, dir, kind);
  }
}

async function* walkDirectory(root: string, dir: string, kind: "raw" | "wiki"): AsyncGenerator<VaultFile> {
  let entries: Array<Dirent<string>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "ENOENT") return;
    throw error;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDirectory(root, absPath, kind);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    yield {
      absPath,
      relPath: normalizeRelPath(relative(root, absPath)),
      kind,
    };
  }
}

function writeIndexedFile(
  db: SqliteDatabase,
  input: {
    readonly relPath: string;
    readonly kind: "raw" | "wiki";
    readonly sizeBytes: number;
    readonly mtimeMs: number;
    readonly contentHash: string;
    readonly generation: number;
    readonly runId: number;
    readonly chunks: ReturnType<typeof chunkMarkdown>;
  },
  options: ReconcileIndexOptions,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare<[string, string, number, number, string, number, number, number]>(
      `INSERT INTO files(relPath, kind, sizeBytes, mtimeMs, contentHash, generation, lastSeenRunId, indexedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(relPath) DO UPDATE SET
         kind = excluded.kind,
         sizeBytes = excluded.sizeBytes,
         mtimeMs = excluded.mtimeMs,
         contentHash = excluded.contentHash,
         generation = excluded.generation,
         lastSeenRunId = excluded.lastSeenRunId,
         errorState = NULL,
         indexedAt = excluded.indexedAt,
         lastErrorAt = NULL`,
    ).run(
      input.relPath,
      input.kind,
      input.sizeBytes,
      input.mtimeMs,
      input.contentHash,
      input.generation,
      input.runId,
      Date.now(),
    );
    db.prepare<[string]>("DELETE FROM chunks WHERE relPath = ?").run(input.relPath);
    emit(options, { type: "fileChunksDeleted", runId: input.runId, relPath: input.relPath });

    const insertChunk = db.prepare<[string, string, number, string | null, number, number, string, string, number]>(
      `INSERT INTO chunks(chunkId, relPath, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.chunks.forEach((chunk, ordinal) => {
      insertChunk.run(
        `${input.relPath}#${input.generation}:${ordinal}`,
        input.relPath,
        ordinal,
        chunk.headingPath,
        chunk.byteStart,
        chunk.byteEnd,
        chunk.text,
        sha256(chunk.text),
        input.generation,
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original indexing failure.
    }
    throw error;
  }
}

function startRun(db: SqliteDatabase): number {
  const runId = nextRunId(db);
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("activeReconcileRunId", String(runId));
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("activeReconcileState", "walking");
  return runId;
}

function nextRunId(db: SqliteDatabase): number {
  const row = db
    .prepare<[], MaxRunIdRow>(`
      SELECT max(runId) AS runId
      FROM (
        SELECT CAST(value AS INTEGER) AS runId
        FROM meta
        WHERE key IN ('activeReconcileRunId', 'lastCompleteRunId', 'lastFinishedRunId')
        UNION ALL
        SELECT max(lastSeenRunId) AS runId FROM files
      )
    `)
    .get();
  return (row?.runId ?? 0) + 1;
}

function markRunComplete(db: SqliteDatabase, runId: number): void {
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("lastCompleteRunId", String(runId));
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("activeReconcileState", "complete");
}

function tombstoneMissingFiles(db: SqliteDatabase, runId: number): number {
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("activeReconcileState", "tombstoning");

  const staleFiles = db
    .prepare<[number], RelPathRow>(
      "SELECT relPath FROM files WHERE lastSeenRunId IS NULL OR lastSeenRunId < ? ORDER BY relPath",
    )
    .all(runId);
  for (const file of staleFiles) {
    tombstoneFile(db, file.relPath);
  }
  return staleFiles.length;
}

function tombstoneFile(db: SqliteDatabase, relPath: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare<[string]>("DELETE FROM chunks WHERE relPath = ?").run(relPath);
    db.prepare<[string]>("DELETE FROM files WHERE relPath = ?").run(relPath);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the tombstone failure.
    }
    throw error;
  }
}

function markRunFinished(db: SqliteDatabase, runId: number): void {
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("lastFinishedRunId", String(runId));
  db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("activeReconcileState", "idle");
}

function normalizeRelPath(path: string): string {
  return path.split(sep).join("/");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function positiveInteger(value: number, name: string): number {
  const integer = Math.trunc(value);
  if (!Number.isFinite(value) || integer < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return integer;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

async function readTextFileWithHash(path: string): Promise<{ readonly text: string; readonly contentHash: string }> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      hash.update(buffer);
      chunks.push(buffer);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    contentHash: hash.digest("hex"),
  };
}
