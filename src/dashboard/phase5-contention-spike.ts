import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { loadSqliteVec, type CapabilityDb } from "../index/native/capability.js";
import {
  createPhase5LocalEmbedder,
  type Phase5LocalEmbedder,
} from "./phase5-local-embedder.js";

type SpikeMode = "dashboard" | "writer";
type Phase5GateDtype = "binary" | "int8" | "float32";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

interface Phase5GateInit {
  readonly mode: SpikeMode;
  readonly dbPath: string;
  readonly rowCount: number;
  readonly dim: number;
  readonly durationMs: number;
  readonly cadenceMs: number;
  readonly dtype: Phase5GateDtype;
  readonly binaryOversampleFactor: number;
  readonly seedDb?: boolean;
  readonly writerBatchSize?: number;
}

interface SqliteDatabase {
  exec(sql: string): void;
  loadExtension(path: string, entrypoint?: string): void;
  pragma(sql: string, options?: { readonly simple?: boolean }): unknown;
  prepare<Params extends unknown[] = unknown[], Row = unknown>(sql: string): SqliteStatement<Params, Row>;
  transaction<T extends (...args: any[]) => unknown>(fn: T): T;
  close(): void;
}

interface SqliteStatement<Params extends unknown[] = unknown[], Row = unknown> {
  run(...params: Params): unknown;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

interface KnnRow {
  readonly rowid: number | bigint;
  readonly distance: number;
}

interface FtsRow {
  readonly rowid: number | bigint;
  readonly score: number;
}

interface BinaryKnnCandidate {
  readonly rowid: number | bigint;
  readonly coarseDistance: number;
}

interface BinaryRescoreRow {
  readonly embeddingRescore: Buffer;
}

interface Int8QueryRow {
  readonly vector: Buffer;
}

interface Phase5SpikeResult {
  readonly mode: SpikeMode;
  readonly pid: number;
  readonly dtype: Phase5GateDtype;
  readonly binaryOversampleFactor: number | null;
  readonly modelLoadMs: number;
  readonly onnxThreads: {
    readonly intraOpNumThreads: number;
    readonly interOpNumThreads: number;
  };
  readonly stats: {
    readonly current: NodeJS.MemoryUsage;
    readonly peakRssBytes: number;
    readonly eventLoopDelay: {
      readonly minMs: number;
      readonly meanMs: number;
      readonly maxMs: number;
      readonly p50Ms: number;
      readonly p95Ms: number;
      readonly p99Ms: number;
    };
    readonly cpu: {
      readonly userMicros: number;
      readonly systemMicros: number;
      readonly totalMicros: number;
      readonly elapsedMs: number;
      readonly cpuPercent: number;
    };
    readonly threadCount: number | null;
  };
  readonly metrics: Record<string, unknown>;
}

interface DashboardGateContext {
  readonly init: Phase5GateInit;
  readonly db: SqliteDatabase;
  readonly embedder: Phase5LocalEmbedder;
  readonly monitor: ReturnType<typeof createStatsMonitor>;
  readonly runKnn: (vector: Buffer, limit: number) => KnnRow[];
  readonly fts: SqliteStatement<[string, number], FtsRow>;
  readonly searchServiceLatencies: number[];
  readonly queryEmbeddingLatencies: number[];
  readonly knnLatencies: number[];
  readonly nonSearchServiceLatencies: number[];
  readonly serializeBytes: number[];
  searchCount: number;
  nonSearchCount: number;
  searchErrors: number;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): SqliteDatabase;
};
const DEFAULT_WRITER_BATCH_SIZE = 32;
const VECTOR_TABLE = "phase5_vectors";
const VECTOR_RESCORE_TABLE = "phase5_vectors_rescore";
const RRF_K = 60;

export async function startPhase5DashboardGateProcess(port: ParentPort, providedInit?: Phase5GateInit): Promise<void> {
  const init = normalizePhase5GateInit(providedInit ?? await waitForInit(port, "dashboard"));
  const monitor = createStatsMonitor();
  let db: SqliteDatabase | null = null;
  let server: HttpServer | null = null;
  let url: string | null = null;

  try {
    await mkdir(dirname(init.dbPath), { recursive: true });
    if (init.seedDb) {
      const writable = openDb(init.dbPath, { readonly: false });
      try {
        createGateSchema(writable, init.dim, init.dtype, true);
        seedGateDb(writable, init);
        writable.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        writable.close();
      }
    }

    const embedder = await createPhase5LocalEmbedder();
    monitor.observe();
    db = openDb(init.dbPath, { readonly: true });
    const context: DashboardGateContext = {
      init,
      db,
      embedder,
      monitor,
      runKnn: createKnnRunner(db, init),
      fts: db.prepare<[string, number], FtsRow>(`
        SELECT rowid, bm25(chunks_fts) AS score
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY score ASC, rowid ASC
        LIMIT ?
      `),
      searchServiceLatencies: [],
      queryEmbeddingLatencies: [],
      knnLatencies: [],
      nonSearchServiceLatencies: [],
      serializeBytes: [],
      searchCount: 0,
      nonSearchCount: 0,
      searchErrors: 0,
    };
    server = createPhase5GateServer(context);
    const portNumber = await listen(server);
    url = `http://127.0.0.1:${portNumber}`;
    port.postMessage({ type: "phase5-gate-ready", mode: init.mode, pid: process.pid, url });
    await waitForStop(port);
    port.postMessage({ type: "phase5-gate-done", result: await dashboardResult(context, url) });
  } catch (error) {
    port.postMessage({ type: "phase5-gate-fail", error: formatError(error) });
    throw error;
  } finally {
    if (server) await closeServer(server);
    db?.close();
  }
}

export async function startPhase5WriterGateProcess(port: ParentPort, providedInit?: Phase5GateInit): Promise<void> {
  const init = normalizePhase5GateInit(providedInit ?? await waitForInit(port, "writer"));
  const monitor = createStatsMonitor();
  let db: SqliteDatabase | null = null;
  try {
    const embedder = await createPhase5LocalEmbedder();
    monitor.observe();
    port.postMessage({ type: "phase5-gate-ready", mode: init.mode, pid: process.pid });
    await waitForStart(port);
    db = openDb(init.dbPath, { readonly: false });
    createGateSchema(db, init.dim, init.dtype, false);
    port.postMessage({ type: "phase5-gate-done", result: await runWriterLoad(init, embedder, monitor, db) });
  } catch (error) {
    port.postMessage({ type: "phase5-gate-fail", error: formatError(error) });
    throw error;
  } finally {
    db?.close();
  }
}

function createPhase5GateServer(context: DashboardGateContext): HttpServer {
  return createServer((req, res) => {
    void handlePhase5GateRequest(context, req, res).catch((error: unknown) => {
      context.searchErrors += 1;
      writeJson(res, 500, { ok: false, error: formatError(error) });
    });
  });
}

async function handlePhase5GateRequest(
  context: DashboardGateContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  if (url.pathname === "/api/non-search" || url.pathname === "/api/status") {
    const started = performance.now();
    context.monitor.observe();
    context.nonSearchCount += 1;
    writeJson(res, 200, {
      ok: true,
      pid: process.pid,
      rowCount: context.init.rowCount,
      searchCount: context.searchCount,
    });
    context.nonSearchServiceLatencies.push(performance.now() - started);
    return;
  }

  if (url.pathname !== "/api/search") {
    writeJson(res, 404, { ok: false, error: "not found" });
    return;
  }

  const started = performance.now();
  const query = url.searchParams.get("q")?.trim() || "phase five local vector search";
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 50);
  try {
    const embedStarted = performance.now();
    const embedding = await context.embedder.embed([query]);
    context.queryEmbeddingLatencies.push(performance.now() - embedStarted);
    const vector = embedding.vectors[0];
    if (!vector || vector.length !== context.init.dim) {
      throw new Error(`query embedding returned invalid dim ${String(vector?.length)}`);
    }

    const ftsRows = runFts(context, query, limit);
    const queryVector = vectorToBuffer(vector);
    const knnStarted = performance.now();
    const knnRows = context.runKnn(queryVector, limit);
    context.knnLatencies.push(performance.now() - knnStarted);
    const results = rrfMerge(ftsRows, knnRows, limit);
    const payload = {
      ok: true,
      query,
      source: "phase5-gate",
      vector: {
        dtype: context.init.dtype,
        dim: embedding.dim,
        elapsedMs: embedding.elapsedMs,
        inputTokens: embedding.inputTokens,
        binaryOversampleFactor: context.init.dtype === "binary" ? context.init.binaryOversampleFactor : null,
        binaryCandidateLimit: context.init.dtype === "binary"
          ? binaryCandidateLimit(limit, context.init.binaryOversampleFactor)
          : null,
      },
      results,
    };
    const bytes = writeJson(res, 200, payload);
    context.serializeBytes.push(bytes);
    context.searchServiceLatencies.push(performance.now() - started);
    context.searchCount += 1;
    context.monitor.observe();
  } catch (error) {
    context.searchErrors += 1;
    throw error;
  }
}

function createKnnRunner(db: SqliteDatabase, init: Phase5GateInit): DashboardGateContext["runKnn"] {
  if (init.dtype === "binary") {
    const coarse = db.prepare<[Buffer, number], BinaryKnnCandidate>(`
      SELECT rowid, distance AS coarseDistance
      FROM ${VECTOR_TABLE}
      WHERE embedding MATCH vec_quantize_binary(?)
      ORDER BY distance
      LIMIT ?
    `);
    const rescore = db.prepare<[number | bigint], BinaryRescoreRow>(`
      SELECT embedding AS embeddingRescore
      FROM ${VECTOR_RESCORE_TABLE}
      WHERE rowid = ?
    `);
    const quantize = db.prepare<[Buffer], Int8QueryRow>("SELECT vec_quantize_int8(?, 'unit') AS vector");
    return (vector, limit) => {
      const query = quantize.get(vector)?.vector;
      if (!Buffer.isBuffer(query)) throw new Error("phase5 binary query int8 quantization did not return a buffer");
      return coarse
        .all(vector, binaryCandidateLimit(limit, init.binaryOversampleFactor))
        .map((row): KnnRow => {
          const stored = rescore.get(row.rowid)?.embeddingRescore;
          if (!Buffer.isBuffer(stored)) throw new Error(`phase5 binary rescore row missing for rowid ${String(row.rowid)}`);
          return {
            rowid: row.rowid,
            distance: int8L2Distance(stored, query),
          };
        })
        .sort((a, b) => a.distance - b.distance || Number(a.rowid) - Number(b.rowid))
        .slice(0, limit);
    };
  }
  if (init.dtype === "int8") {
    const exact = db.prepare<[Buffer, number], KnnRow>(`
      SELECT rowid, distance
      FROM ${VECTOR_TABLE}
      WHERE embedding MATCH vec_quantize_int8(?, 'unit')
      ORDER BY distance
      LIMIT ?
    `);
    return (vector, limit) => exact.all(vector, limit);
  }
  const exact = db.prepare<[Buffer, number], KnnRow>(`
    SELECT rowid, distance
    FROM ${VECTOR_TABLE}
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `);
  return (vector, limit) => exact.all(vector, limit);
}

function runFts(context: DashboardGateContext, query: string, limit: number): FtsRow[] {
  const match = toSimpleFtsQuery(query);
  if (!match) return [];
  try {
    return context.fts.all(match, limit);
  } catch (error) {
    if (error instanceof Error && /fts5|match|syntax|malformed|unterminated/i.test(error.message)) return [];
    throw error;
  }
}

async function dashboardResult(context: DashboardGateContext, url: string | null): Promise<Phase5SpikeResult> {
  return {
    mode: "dashboard",
    pid: process.pid,
    dtype: context.init.dtype,
    binaryOversampleFactor: context.init.dtype === "binary" ? context.init.binaryOversampleFactor : null,
    modelLoadMs: context.embedder.loadTimeMs,
    onnxThreads: {
      intraOpNumThreads: context.embedder.intraOpNumThreads,
      interOpNumThreads: context.embedder.interOpNumThreads,
    },
    stats: context.monitor.snapshot(),
    metrics: {
      dtype: context.init.dtype,
      binaryOversampleFactor: context.init.dtype === "binary" ? context.init.binaryOversampleFactor : null,
      url,
      searchCount: context.searchCount,
      searchErrors: context.searchErrors,
      searchService: summarizeTimes(context.searchServiceLatencies),
      queryEmbeddingService: summarizeTimes(context.queryEmbeddingLatencies),
      knnService: summarizeTimes(context.knnLatencies),
      nonSearchService: summarizeTimes(context.nonSearchServiceLatencies),
      nonSearchCount: context.nonSearchCount,
      serializeBytes: summarizeValues(context.serializeBytes),
      dbBytes: await measureDbBytes(context.init.dbPath),
    },
  };
}

async function runWriterLoad(
  init: Phase5GateInit,
  embedder: Phase5LocalEmbedder,
  monitor: ReturnType<typeof createStatsMonitor>,
  db: SqliteDatabase,
): Promise<Phase5SpikeResult> {
  const batchSize = init.writerBatchSize ?? DEFAULT_WRITER_BATCH_SIZE;
  const insertFile = db.prepare<[string, number, string, number]>(`
    INSERT OR IGNORE INTO files(relPath, kind, sizeBytes, mtimeMs, contentHash, generation, lastSeenRunId, indexedAt)
    VALUES (?, 'markdown', ?, 0, ?, 2, 2, ?)
  `);
  const insertChunk = db.prepare<[bigint, string, string, number, string, number, number, string, string, number]>(`
    INSERT INTO chunks(rowid, chunkId, relPath, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVector = createVectorInserter(db, init);
  const insertBatch = db.transaction((rows: readonly WriterRow[]) => {
    for (const row of rows) {
      insertFile.run(row.relPath, row.text.length, row.textHash, Date.now());
      insertChunk.run(
        BigInt(row.rowid),
        row.chunkId,
        row.relPath,
        row.ordinal,
        row.headingPath,
        0,
        row.text.length,
        row.text,
        row.textHash,
        2,
      );
      insertVector(BigInt(row.rowid), vectorToBuffer(row.vector));
    }
  });

  const started = performance.now();
  const deadline = started + init.durationMs;
  let docs = 0;
  let tokens = 0;
  let inserted = 0;
  const batchTimes: number[] = [];
  const insertTimes: number[] = [];

  while (performance.now() < deadline) {
    const firstRowid = init.rowCount + docs + 1;
    const texts = Array.from({ length: batchSize }, (_, index) => (
      `phase five writer synthetic chunk ${firstRowid + index} local vector search under WAL contention`
    ));
    const embedStarted = performance.now();
    const batch = await embedder.embed(texts);
    batchTimes.push(performance.now() - embedStarted);
    tokens += batch.inputTokens;
    const rows = texts.map((text, index): WriterRow => {
      const rowid = firstRowid + index;
      return {
        rowid,
        chunkId: `phase5-writer-${rowid}`,
        relPath: phase5RelPath(rowid),
        ordinal: phase5Ordinal(rowid),
        headingPath: "Phase 5 Writer",
        text,
        textHash: sha256(text),
        vector: batch.vectors[index] ?? [],
      };
    });
    const insertStarted = performance.now();
    insertBatch(rows);
    insertTimes.push(performance.now() - insertStarted);
    docs += rows.length;
    inserted += rows.length;
    monitor.observe();
    await sleep(0);
  }

  const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  const docsPerSecond = docs / elapsedSeconds;
  db.pragma("wal_checkpoint(PASSIVE)");
  return {
    mode: "writer",
    pid: process.pid,
    dtype: init.dtype,
    binaryOversampleFactor: init.dtype === "binary" ? init.binaryOversampleFactor : null,
    modelLoadMs: embedder.loadTimeMs,
    onnxThreads: {
      intraOpNumThreads: embedder.intraOpNumThreads,
      interOpNumThreads: embedder.interOpNumThreads,
    },
    stats: monitor.snapshot(),
    metrics: {
      docs,
      inserted,
      tokens,
      elapsedSeconds,
      docsPerSecond,
      projectedBackfillSeconds: init.rowCount / Math.max(docsPerSecond, 0.001),
      projectedBackfillMinutes: init.rowCount / Math.max(docsPerSecond, 0.001) / 60,
      tokensPerSecond: tokens / elapsedSeconds,
      batch: summarizeTimes(batchTimes),
      insert: summarizeTimes(insertTimes),
      dbBytes: await measureDbBytes(init.dbPath),
    },
  };
}

interface WriterRow {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly ordinal: number;
  readonly headingPath: string;
  readonly text: string;
  readonly textHash: string;
  readonly vector: readonly number[];
}

function openDb(dbPath: string, opts: { readonly readonly: boolean }): SqliteDatabase {
  const db = new BetterSqlite3(dbPath, opts.readonly ? { readonly: true, fileMustExist: true } : {});
  loadSqliteVec({ path: dbPath, database: db as CapabilityDb["database"] });
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -200000");
  db.pragma("mmap_size = 1073741824");
  if (!opts.readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  return db;
}

function createGateSchema(db: SqliteDatabase, dim: number, dtype: Phase5GateDtype, reset: boolean): void {
  const vectorSchema = dtype === "binary"
    ? `embedding bit[${dim}]`
    : `embedding ${dtype === "int8" ? "int8" : "float"}[${dim}]`;
  const binaryRescoreSchema = dtype === "binary"
    ? `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_RESCORE_TABLE} USING vec0(embedding int8[${dim}]);`
    : "";
  db.exec(`
    ${reset ? `
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS ${VECTOR_RESCORE_TABLE};
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS ${VECTOR_TABLE};
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS meta;
    ` : ""}
    CREATE TABLE IF NOT EXISTS files (
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
      relPath TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(${vectorSchema});
    ${binaryRescoreSchema}
    CREATE INDEX IF NOT EXISTS idx_chunks_relPath ON chunks(relPath);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_relPath_ordinal ON chunks(relPath, ordinal);
  `);
}

function seedGateDb(db: SqliteDatabase, init: Phase5GateInit): void {
  const insertFile = db.prepare<[string, number, string, number]>(`
    INSERT OR IGNORE INTO files(relPath, kind, sizeBytes, mtimeMs, contentHash, generation, lastSeenRunId, indexedAt)
    VALUES (?, 'markdown', ?, 0, ?, 1, 1, ?)
  `);
  const insertChunk = db.prepare<[bigint, string, string, number, string, number, number, string, string, number]>(`
    INSERT INTO chunks(rowid, chunkId, relPath, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVector = createVectorInserter(db, init);
  const batchSize = 1_000;
  const txn = db.transaction((start: number) => {
    const end = Math.min(init.rowCount, start + batchSize - 1);
    for (let rowid = start; rowid <= end; rowid += 1) {
      const text = `phase five seed chunk ${rowid} local vector search dashboard contention`;
      const relPath = phase5RelPath(rowid);
      insertFile.run(relPath, text.length, `phase5-file-${Math.floor((rowid - 1) / 100)}`, Date.now());
      insertChunk.run(
        BigInt(rowid),
        `phase5-seed-${rowid}`,
        relPath,
        phase5Ordinal(rowid),
        "Phase 5 Seed",
        0,
        text.length,
        text,
        sha256(text),
        1,
      );
      insertVector(BigInt(rowid), vectorBuffer(rowid, init.dim));
    }
  });

  for (let start = 1; start <= init.rowCount; start += batchSize) {
    txn(start);
    if (start % 50_000 === 1) {
      console.info(`[phase5-gate] seeded ${Math.min(init.rowCount, start + batchSize - 1)}/${init.rowCount}`);
    }
  }
}

function createVectorInserter(db: SqliteDatabase, init: Phase5GateInit): (rowid: bigint, vector: Buffer) => void {
  if (init.dtype === "binary") {
    const insertCoarse = db.prepare<[bigint, Buffer]>(`
      INSERT INTO ${VECTOR_TABLE}(rowid, embedding)
      VALUES (?, vec_quantize_binary(?))
    `);
    const insertRescore = db.prepare<[bigint, Buffer]>(`
      INSERT INTO ${VECTOR_RESCORE_TABLE}(rowid, embedding)
      VALUES (?, vec_quantize_int8(?, 'unit'))
    `);
    return (rowid, vector) => {
      insertCoarse.run(rowid, vector);
      insertRescore.run(rowid, vector);
    };
  }
  if (init.dtype === "int8") {
    const insert = db.prepare<[bigint, Buffer]>(`
      INSERT INTO ${VECTOR_TABLE}(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))
    `);
    return (rowid, vector) => {
      insert.run(rowid, vector);
    };
  }
  const insert = db.prepare<[bigint, Buffer]>(`
    INSERT INTO ${VECTOR_TABLE}(rowid, embedding) VALUES (?, ?)
  `);
  return (rowid, vector) => {
    insert.run(rowid, vector);
  };
}

function rrfMerge(ftsRows: readonly FtsRow[], knnRows: readonly KnnRow[], limit: number): Array<{
  readonly rowid: number;
  readonly score: number;
  readonly ftsRank: number | null;
  readonly vectorRank: number | null;
  readonly vectorDistance: number | null;
}> {
  const results = new Map<number, {
    rowid: number;
    score: number;
    ftsRank: number | null;
    vectorRank: number | null;
    vectorDistance: number | null;
  }>();

  ftsRows.forEach((row, rank) => {
    const rowid = Number(row.rowid);
    results.set(rowid, {
      rowid,
      score: 1 / (RRF_K + rank + 1),
      ftsRank: rank + 1,
      vectorRank: null,
      vectorDistance: null,
    });
  });

  knnRows.forEach((row, rank) => {
    const rowid = Number(row.rowid);
    const existing = results.get(rowid);
    if (existing) {
      existing.score += 1 / (RRF_K + rank + 1);
      existing.vectorRank = rank + 1;
      existing.vectorDistance = row.distance;
      return;
    }
    results.set(rowid, {
      rowid,
      score: 1 / (RRF_K + rank + 1),
      ftsRank: null,
      vectorRank: rank + 1,
      vectorDistance: row.distance,
    });
  });

  return [...results.values()]
    .sort((a, b) => b.score - a.score || a.rowid - b.rowid)
    .slice(0, limit);
}

async function measureDbBytes(dbPath: string): Promise<{ readonly db: number; readonly wal: number; readonly shm: number; readonly total: number }> {
  const db = await fileSize(dbPath);
  const wal = await fileSize(`${dbPath}-wal`);
  const shm = await fileSize(`${dbPath}-shm`);
  return { db, wal, shm, total: db + wal + shm };
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function vectorBuffer(rowid: number, dim: number): Buffer {
  return Buffer.from(new Uint8Array(vectorArray(rowid, dim).buffer));
}

function vectorArray(rowid: number, dim: number): Float32Array {
  const values = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    const raw = (((rowid * 1103515245 + i * 12345) >>> 0) % 2001) / 1000 - 1;
    values[i] = raw;
    norm += raw * raw;
  }
  const scale = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) values[i] /= scale;
  return values;
}

function vectorToBuffer(values: readonly number[]): Buffer {
  const vector = new Float32Array(values);
  return Buffer.from(new Uint8Array(vector.buffer));
}

function binaryCandidateLimit(limit: number, oversampleFactor: number): number {
  return Math.max(limit, limit * oversampleFactor);
}

function int8L2Distance(left: Buffer, right: Buffer): number {
  if (left.length !== right.length) {
    throw new Error(`phase5 binary rescore dimension mismatch: ${left.length} != ${right.length}`);
  }
  let total = 0;
  for (let i = 0; i < left.length; i += 1) {
    const delta = left.readInt8(i) - right.readInt8(i);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

function createStatsMonitor(): {
  observe(): void;
  snapshot(): Phase5SpikeResult["stats"];
} {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  return {
    observe: () => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    },
    snapshot: () => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
      const elapsedMs = Math.max(performance.now() - startedAt, 0.001);
      const cpu = process.cpuUsage(startedCpu);
      const totalMicros = cpu.user + cpu.system;
      const stats = {
        current: process.memoryUsage(),
        peakRssBytes,
        eventLoopDelay: {
          minMs: nsToMs(delay.min),
          meanMs: nsToMs(delay.mean),
          maxMs: nsToMs(delay.max),
          p50Ms: nsToMs(delay.percentile(50)),
          p95Ms: nsToMs(delay.percentile(95)),
          p99Ms: nsToMs(delay.percentile(99)),
        },
        cpu: {
          userMicros: cpu.user,
          systemMicros: cpu.system,
          totalMicros,
          elapsedMs,
          cpuPercent: totalMicros / (elapsedMs * 1000) * 100,
        },
        threadCount: readThreadCount(process.pid),
      };
      delay.disable();
      return stats;
    },
  };
}

function readThreadCount(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const match = /^Threads:\s*(\d+)/mu.exec(status);
      return match ? Number(match[1]) : null;
    }
    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-o", "thcount=", "-p", String(pid)], { encoding: "utf8" });
      const count = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(count) ? count : null;
    }
    if (process.platform === "win32") {
      const powershell = existsSync("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : "powershell.exe";
      const result = spawnSync(
        powershell,
        ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Threads.Count`],
        { encoding: "utf8", windowsHide: true },
      );
      const count = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(count) ? count : null;
    }
  } catch {
    return null;
  }
  return null;
}

function waitForInit(port: ParentPort, mode: SpikeMode): Promise<Phase5GateInit> {
  return new Promise((resolveInit, reject) => {
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (!isSpikeInit(payload) || payload.mode !== mode) {
        reject(new Error(`phase5 ${mode} gate expected an init payload`));
        return;
      }
      resolveInit(payload);
    });
  });
}

function normalizePhase5GateInit(init: Phase5GateInit): Phase5GateInit {
  const dtype = isPhase5GateDtype((init as { readonly dtype?: unknown }).dtype) ? init.dtype : "binary";
  const rawOversample = (init as { readonly binaryOversampleFactor?: unknown }).binaryOversampleFactor;
  const binaryOversampleFactor = Number.isInteger(rawOversample) && Number(rawOversample) > 0
    ? Number(rawOversample)
    : 2;
  if (dtype === "binary" && init.dim % 8 !== 0) {
    throw new Error(`phase5 binary dtype requires dim divisible by 8, got ${init.dim}`);
  }
  return { ...init, dtype, binaryOversampleFactor };
}

function waitForStart(port: ParentPort): Promise<void> {
  return new Promise((resolveStart) => {
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "start") {
        resolveStart();
      }
    });
  });
}

function waitForStop(port: ParentPort): Promise<void> {
  return new Promise((resolveStop) => {
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (
        payload === "shutdown" ||
        (typeof payload === "object" &&
          payload !== null &&
          ((payload as { type?: unknown }).type === "shutdown" ||
            (payload as { type?: unknown }).type === "phase5-stop"))
      ) {
        resolveStop();
      }
    });
  });
}

function isSpikeInit(message: unknown): message is Phase5GateInit {
  if (typeof message !== "object" || message === null) return false;
  const mode = (message as { mode?: unknown }).mode;
  const dtype = (message as { dtype?: unknown }).dtype;
  const binaryOversampleFactor = (message as { binaryOversampleFactor?: unknown }).binaryOversampleFactor;
  return (
    (mode === "dashboard" || mode === "writer") &&
    typeof (message as { dbPath?: unknown }).dbPath === "string" &&
    Number.isInteger((message as { rowCount?: unknown }).rowCount) &&
    Number.isInteger((message as { dim?: unknown }).dim) &&
    Number.isInteger((message as { durationMs?: unknown }).durationMs) &&
    Number.isInteger((message as { cadenceMs?: unknown }).cadenceMs) &&
    (dtype === undefined || isPhase5GateDtype(dtype)) &&
    (binaryOversampleFactor === undefined || Number.isInteger(binaryOversampleFactor))
  );
}

function isPhase5GateDtype(value: unknown): value is Phase5GateDtype {
  return value === "binary" || value === "int8" || value === "float32";
}

function unwrapParentPortMessage(message: unknown): unknown {
  if (typeof message === "object" && message !== null && "data" in message) {
    return (message as { data: unknown }).data;
  }
  return message;
}

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("phase5 gate server did not expose a TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): number {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
  return Buffer.byteLength(payload);
}

function summarizeTimes(values: readonly number[]): {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
} {
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length ? Math.max(...values) : 0,
  };
}

function summarizeValues(values: readonly number[]): {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
} {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))] ?? 0;
}

function toSimpleFtsQuery(query: string): string | null {
  const normalized = query.normalize("NFKC");
  const terms = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const filtered = terms.filter((term) => !["AND", "OR", "NOT", "NEAR"].includes(term.toUpperCase()));
  if (filtered.length === 0) return null;
  return filtered.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" AND ");
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function phase5RelPath(rowid: number): string {
  return `phase5/synthetic-${Math.floor((rowid - 1) / 100).toString().padStart(6, "0")}.md`;
}

function phase5Ordinal(rowid: number): number {
  return (rowid - 1) % 100;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function nsToMs(value: number): number {
  return Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER ? value / 1_000_000 : 0;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

declare global {
  namespace NodeJS {
    interface Process {
      parentPort?: ParentPort;
    }
  }
}
