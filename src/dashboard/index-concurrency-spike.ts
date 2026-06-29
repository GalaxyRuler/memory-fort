import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import process from "node:process";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import v8 from "node:v8";

type SpikeMode = "option-b" | "option-a-service" | "option-a-writer";

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
}

interface SpikeInit {
  readonly mode: SpikeMode;
  readonly vaultRoot: string;
  readonly dbDir: string;
  readonly chunkBytes?: number;
  readonly chunksPerTxn?: number;
  readonly searchPort?: number;
  readonly query?: string;
  readonly writerResetsDb?: boolean;
}

interface SqliteDatabase {
  exec(sql: string): void;
  pragma(sql: string, options?: { readonly simple?: boolean }): unknown;
  prepare<Params extends unknown[] = unknown[], Row = unknown>(sql: string): SqliteStatement<Params, Row>;
  close(): void;
}

interface SqliteStatement<Params extends unknown[] = unknown[], Row = unknown> {
  run(...params: Params): unknown;
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

interface BetterSqlite3Constructor {
  new (path: string, options?: { readonly?: boolean; fileMustExist?: boolean }): SqliteDatabase;
}

interface SearchRow {
  readonly rowid: number | bigint;
  readonly relPath: string;
  readonly score: number;
}

interface ChunkRow {
  readonly relPath: string;
  readonly ordinal: number;
  readonly text: string;
}

interface FileEntry {
  readonly path: string;
  readonly relPath: string;
  readonly sizeBytes: number;
}

interface MemorySnapshot {
  readonly rss: number;
  readonly external: number;
  readonly arrayBuffers: number;
  readonly heapUsed: number;
  readonly usedHeapSize: number;
}

interface EventLoopDelaySnapshot {
  readonly minMs: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

interface PeakMemorySnapshot extends MemorySnapshot {
  readonly sampledAt: string;
}

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3") as BetterSqlite3Constructor;
const parentPort = process.parentPort;
const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_CHUNKS_PER_TXN = 32;
const DEFAULT_QUERY = "needle";
const SPIKE_DB_NAME = "index-concurrency-spike.sqlite";

if (!parentPort) {
  console.error("[index-spike] process.parentPort is required");
  process.exit(1);
}

if (process.env["MEMORY_INDEX_SPIKE"] !== "1") {
  console.error("[index-spike] MEMORY_INDEX_SPIKE=1 is required");
  process.exit(1);
}

waitForInit(parentPort)
  .then((init) => runSpikeChild(parentPort, init))
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(`[index-spike] fatal ${formatError(error)}`);
    parentPort.postMessage({ type: "index-spike-fail", error: formatError(error) });
    process.exit(1);
  });

async function runSpikeChild(port: ParentPort, init: SpikeInit): Promise<void> {
  if (init.mode === "option-b") {
    await runOptionB(port, init);
    return;
  }
  if (init.mode === "option-a-service") {
    await runOptionAService(port, init);
    return;
  }
  await runOptionAWriter(port, init);
}

async function runOptionB(port: ParentPort, init: SpikeInit): Promise<void> {
  await mkdir(init.dbDir, { recursive: true });
  const dbPath = join(init.dbDir, SPIKE_DB_NAME);
  const owner = createOwnerStats();
  const writer = openWritableDb(dbPath);
  resetSchema(writer);
  const reader = openReadOnlyDb(dbPath);
  const server = await startSearchServer(reader, init);
  const ready = {
    type: "index-spike-ready",
    mode: init.mode,
    pid: process.pid,
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    dbPath,
  };
  port.postMessage(ready);
  await waitForStart(port);

  try {
    const result = await reconcileVault(writer, init, owner);
    port.postMessage({
      type: "index-spike-done",
      mode: init.mode,
      result: {
        ...result,
        dbPath,
        dbBytes: await measureDbBytes(dbPath),
        owner: owner.snapshot(),
      },
    });
    await waitForShutdown(port, 30_000);
  } finally {
    await server.close();
    closeQuietly(reader);
    closeQuietly(writer);
  }
}

async function runOptionAService(port: ParentPort, init: SpikeInit): Promise<void> {
  await mkdir(init.dbDir, { recursive: true });
  const dbPath = join(init.dbDir, SPIKE_DB_NAME);
  const bootstrap = openWritableDb(dbPath);
  resetSchema(bootstrap);
  closeQuietly(bootstrap);

  const reader = openReadOnlyDb(dbPath);
  const server = await startSearchServer(reader, init);
  port.postMessage({
    type: "index-spike-ready",
    mode: init.mode,
    pid: process.pid,
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    dbPath,
  });

  try {
    await waitForShutdown(port, 30 * 60_000);
  } finally {
    await server.close();
    closeQuietly(reader);
  }
}

async function runOptionAWriter(port: ParentPort, init: SpikeInit): Promise<void> {
  await mkdir(init.dbDir, { recursive: true });
  const dbPath = join(init.dbDir, SPIKE_DB_NAME);
  const owner = createOwnerStats();
  const writer = openWritableDb(dbPath);
  if (init.writerResetsDb) resetSchema(writer);
  port.postMessage({
    type: "index-spike-ready",
    mode: init.mode,
    pid: process.pid,
    dbPath,
  });
  await waitForStart(port);

  try {
    const result = await reconcileVault(writer, init, owner);
    port.postMessage({
      type: "index-spike-done",
      mode: init.mode,
      result: {
        ...result,
        dbPath,
        dbBytes: await measureDbBytes(dbPath),
        owner: owner.snapshot(),
      },
    });
    await waitForShutdown(port, 30_000);
  } finally {
    closeQuietly(writer);
  }
}

function openWritableDb(dbPath: string): SqliteDatabase {
  const db = new BetterSqlite3(dbPath);
  const journalMode = db.pragma("journal_mode = WAL", { simple: true });
  if (String(journalMode).toLowerCase() !== "wal") {
    db.close();
    throw new Error(`failed to enable WAL for ${dbPath}; got ${String(journalMode)}`);
  }
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function openReadOnlyDb(dbPath: string): SqliteDatabase {
  const db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
  return db;
}

function resetSchema(db: SqliteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks;
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY,
      relPath TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      text,
      relPath UNINDEXED,
      content='chunks',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, relPath) VALUES (new.rowid, new.text, new.relPath);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, relPath)
      VALUES('delete', old.rowid, old.text, old.relPath);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, relPath)
      VALUES('delete', old.rowid, old.text, old.relPath);
      INSERT INTO chunks_fts(rowid, text, relPath) VALUES (new.rowid, new.text, new.relPath);
    END;
    CREATE INDEX idx_chunks_relPath ON chunks(relPath);
  `);
}

async function startSearchServer(
  db: SqliteDatabase,
  init: SpikeInit,
): Promise<{ readonly port: number; close(): Promise<void> }> {
  const query = init.query ?? DEFAULT_QUERY;
  const search = db.prepare<[string, number], SearchRow>(`
    SELECT chunks_fts.rowid AS rowid, chunks.relPath AS relPath, bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks ON chunks.rowid = chunks_fts.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY score ASC, chunks_fts.rowid ASC
    LIMIT ?
  `);

  const server = createServer((req, res) => {
    const started = performance.now();
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/health") {
        writeJson(res, { ok: true, pid: process.pid, mode: init.mode });
        return;
      }
      if (url.pathname !== "/api/search") {
        writeJson(res, { ok: false, error: "not found" }, 404);
        return;
      }
      const requested = url.searchParams.get("q")?.trim() || query;
      const limit = clampInt(url.searchParams.get("limit"), 20, 1, 50);
      const rows = search.all(sanitizeFtsQuery(requested), limit);
      writeJson(res, {
        ok: true,
        pid: process.pid,
        mode: init.mode,
        elapsedMs: performance.now() - started,
        count: rows.length,
        rows: rows.map((row) => ({
          rowid: Number(row.rowid),
          relPath: row.relPath,
          score: row.score,
        })),
      });
    } catch (error) {
      writeJson(res, { ok: false, error: formatError(error) }, 500);
    }
  });
  const port = await listen(server, init.searchPort ?? 0);
  return {
    port,
    close: () => closeServer(server),
  };
}

async function reconcileVault(
  db: SqliteDatabase,
  init: SpikeInit,
  owner: ReturnType<typeof createOwnerStats>,
): Promise<{
  readonly wallTimeMs: number;
  readonly filesIndexed: number;
  readonly chunksIndexed: number;
  readonly transactions: number;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly chunksPerTxn: number;
}> {
  const chunkBytes = init.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const chunksPerTxn = init.chunksPerTxn ?? DEFAULT_CHUNKS_PER_TXN;
  const started = performance.now();
  const files = await listMarkdownFiles(init.vaultRoot);
  const insert = db.prepare<[string, number, string]>(
    "INSERT INTO chunks(relPath, ordinal, text) VALUES (?, ?, ?)",
  );

  let chunksIndexed = 0;
  let filesIndexed = 0;
  let transactions = 0;
  let totalBytes = 0;
  const pending: ChunkRow[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const chunk of pending) {
        insert.run(chunk.relPath, chunk.ordinal, chunk.text);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Keep the original transaction failure.
      }
      throw error;
    }
    chunksIndexed += pending.length;
    pending.length = 0;
    transactions += 1;
    owner.observe();
    await yieldImmediate();
  };

  for (const file of files) {
    filesIndexed += 1;
    totalBytes += file.sizeBytes;
    let ordinal = 0;
    for await (const text of readTextChunks(file.path, chunkBytes)) {
      pending.push({ relPath: file.relPath, ordinal, text });
      ordinal += 1;
      if (pending.length >= chunksPerTxn) {
        await flush();
      }
    }
  }
  await flush();
  owner.observe();

  return {
    wallTimeMs: performance.now() - started,
    filesIndexed,
    chunksIndexed,
    transactions,
    totalBytes,
    chunkBytes,
    chunksPerTxn,
  };
}

async function listMarkdownFiles(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const rootPath = resolve(root);
  await walk(rootPath);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return entries;

  async function walk(dir: string): Promise<void> {
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const childPath = join(dir, child.name);
      if (child.isDirectory()) {
        await walk(childPath);
        continue;
      }
      if (!child.isFile() || !child.name.endsWith(".md")) continue;
      const info = await stat(childPath);
      entries.push({
        path: childPath,
        relPath: relative(rootPath, childPath).replace(/\\/g, "/"),
        sizeBytes: info.size,
      });
    }
  }
}

async function* readTextChunks(path: string, chunkBytes: number): AsyncGenerator<string> {
  for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    yield buffer.toString("utf8");
  }
}

function createOwnerStats(): {
  observe(): void;
  snapshot(): {
    readonly current: MemorySnapshot;
    readonly peak: PeakMemorySnapshot;
    readonly eventLoopDelay: EventLoopDelaySnapshot;
  };
} {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let peak = { ...readMemory(), sampledAt: new Date().toISOString() };
  return {
    observe: () => {
      const current = readMemory();
      if (current.rss > peak.rss || current.usedHeapSize > peak.usedHeapSize) {
        peak = { ...current, sampledAt: new Date().toISOString() };
      }
    },
    snapshot: () => {
      const current = readMemory();
      if (current.rss > peak.rss || current.usedHeapSize > peak.usedHeapSize) {
        peak = { ...current, sampledAt: new Date().toISOString() };
      }
      const eventLoopDelay = {
        minMs: nsToMs(delay.min),
        meanMs: nsToMs(delay.mean),
        maxMs: nsToMs(delay.max),
        p50Ms: nsToMs(delay.percentile(50)),
        p95Ms: nsToMs(delay.percentile(95)),
        p99Ms: nsToMs(delay.percentile(99)),
      };
      delay.disable();
      return { current, peak, eventLoopDelay };
    },
  };
}

function readMemory(): MemorySnapshot {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    heapUsed: memory.heapUsed,
    usedHeapSize: v8.getHeapStatistics().used_heap_size,
  };
}

async function measureDbBytes(dbPath: string): Promise<{
  readonly db: number;
  readonly wal: number;
  readonly shm: number;
  readonly total: number;
}> {
  const db = await fileSize(dbPath);
  const wal = await fileSize(`${dbPath}-wal`);
  const shm = await fileSize(`${dbPath}-shm`);
  return { db, wal, shm, total: db + wal + shm };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address !== "object" || !address) {
        reject(new Error("search server did not expose a TCP address"));
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

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sanitizeFtsQuery(query: string): string {
  const terms = query
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" ") : `"${DEFAULT_QUERY}"`;
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function waitForInit(port: ParentPort): Promise<SpikeInit> {
  return new Promise((resolveInit, reject) => {
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (!isSpikeInit(payload)) {
        reject(new Error("index spike expected an init payload"));
        return;
      }
      resolveInit(payload);
    });
  });
}

function waitForStart(port: ParentPort): Promise<void> {
  return waitForCommand(port, "start", 30_000);
}

function waitForShutdown(port: ParentPort, timeoutMs: number): Promise<void> {
  return waitForCommand(port, "shutdown", timeoutMs, true);
}

function waitForCommand(
  port: ParentPort,
  command: "start" | "shutdown",
  timeoutMs: number,
  resolveOnTimeout = false,
): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    const timer = setTimeout(() => {
      if (resolveOnTimeout) resolveCommand();
      else reject(new Error(`timed out waiting for ${command} command after ${timeoutMs}ms`));
    }, timeoutMs);
    port.on("message", (message) => {
      const payload = unwrapParentPortMessage(message);
      if (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { type?: unknown }).type === command
      ) {
        clearTimeout(timer);
        resolveCommand();
      }
    });
  });
}

function isSpikeInit(message: unknown): message is SpikeInit {
  if (typeof message !== "object" || message === null) return false;
  const mode = (message as { mode?: unknown }).mode;
  return (
    (mode === "option-b" || mode === "option-a-service" || mode === "option-a-writer") &&
    typeof (message as { vaultRoot?: unknown }).vaultRoot === "string" &&
    typeof (message as { dbDir?: unknown }).dbDir === "string"
  );
}

function unwrapParentPortMessage(message: unknown): unknown {
  if (
    typeof message === "object" &&
    message !== null &&
    "data" in message
  ) {
    return (message as { data: unknown }).data;
  }
  return message;
}

function closeQuietly(db: SqliteDatabase): void {
  try {
    db.close();
  } catch {
    // Best-effort cleanup for a throwaway spike.
  }
}

function nsToMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value / 1_000_000;
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
