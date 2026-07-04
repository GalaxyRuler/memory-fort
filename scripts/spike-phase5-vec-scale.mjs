#!/usr/bin/env node
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const { values } = parseArgs({
  options: {
    rows: { type: "string", default: "525345" },
    dim: { type: "string", default: "384" },
    dtype: { type: "string", multiple: true, default: ["float32", "int8", "binary"] },
    "db-dir": { type: "string" },
    "query-count": { type: "string", default: "100" },
    "binary-oversample-factor": { type: "string", default: "2" },
    "result-json": { type: "string" },
    "evidence-path": { type: "string" },
    "max-rss-mib": { type: "string", default: "1536" },
    "max-heap-mib": { type: "string", default: "512" },
    "overwrite": { type: "boolean", default: false },
  },
});

const rowCount = readPositiveInt(values.rows, "--rows");
const dim = readPositiveInt(values.dim, "--dim");
const queryCount = readPositiveInt(values["query-count"], "--query-count");
const binaryOversampleFactor = readPositiveInt(values["binary-oversample-factor"], "--binary-oversample-factor");
const maxRssBytes = readPositiveInt(values["max-rss-mib"], "--max-rss-mib") * 1024 * 1024;
const maxHeapBytes = readPositiveInt(values["max-heap-mib"], "--max-heap-mib") * 1024 * 1024;
const dtypes = [...new Set(asArray(values.dtype).map(String))];
const dbDir = path.resolve(values["db-dir"] ?? path.join(process.cwd(), "tmp", "phase5-vec-scale"));
const resultJson = path.resolve(values["result-json"] ?? path.join(dbDir, `phase5-vec-scale-${defaultDate}.json`));
const evidencePath = path.resolve(
  values["evidence-path"] ?? path.join(repoRoot, "docs", "release-evidence", `phase5-task0-vec-scale-${defaultDate}.md`),
);

if (!dtypes.every((dtype) => dtype === "float32" || dtype === "int8" || dtype === "binary")) {
  throw new Error(`unsupported --dtype list: ${dtypes.join(", ")}`);
}
if (dim % 8 !== 0 && dtypes.includes("binary")) {
  throw new Error("--dim must be divisible by 8 for binary quantization");
}

await mkdir(dbDir, { recursive: true });
if (values.overwrite) {
  await rm(dbDir, { recursive: true, force: true });
  await mkdir(dbDir, { recursive: true });
}

const runs = [];
for (const dtype of dtypes) {
  runs.push(await runDtype(dtype));
}

const result = {
  generatedAt: new Date().toISOString(),
  rowCount,
  dim,
  queryCount,
  binaryOversampleFactor,
  reopenMethod: "close DB, reopen a fresh better-sqlite3 connection, rerun KNN; this is not an OS-cold page-cache measurement",
  crossProcessWriteContention: "measured by the packaged Phase 5 Task 0C gate, where the real dashboard-service and index-writer entries share the WAL DB",
  memoryBounds: { maxRssBytes, maxHeapBytes },
  runs,
};

await mkdir(path.dirname(resultJson), { recursive: true });
await writeFile(resultJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, renderEvidence(result), "utf8");

console.log(`[phase5-vec-scale] result ${resultJson}`);
console.log(`[phase5-vec-scale] evidence ${evidencePath}`);

async function runDtype(dtype) {
  const dbPath = path.join(dbDir, `phase5-vec-scale-${dtype}.sqlite`);
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });

  const db = openDb(dbPath);
  const startedSeed = performance.now();
  createSchema(db, dtype);
  seedVectors(db, dtype);
  const seedMs = performance.now() - startedSeed;
  db.pragma("wal_checkpoint(TRUNCATE)");
  const steadyStateBytes = await measureDbBytes(dbPath);
  const warm = measureQueries(db, dtype, queryCount);
  const sameProcessWrite = measureDuringWriteLoad(db, dtype, queryCount);
  db.close();

  const reopened = openDb(dbPath, true);
  const reopen = measureQueries(reopened, dtype, queryCount);
  reopened.close();

  const finalBytes = await measureDbBytes(dbPath);
  const memory = process.memoryUsage();
  assertMemoryBound(dtype, memory);
  return {
    dtype,
    dbPath,
    rowCount,
    dim,
    seedMs,
    warm,
    reopen,
    sameProcessWrite,
    steadyStateBytes,
    finalBytes,
    memory,
  };
}

function openDb(dbPath, readonly = false) {
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : {});
  sqliteVec.load(db);
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -200000");
  db.pragma("mmap_size = 1073741824");
  return db;
}

function createSchema(db, dtype) {
  const vectorSchema = dtype === "binary"
    ? `embedding bit[${dim}]`
    : `embedding ${dtype === "int8" ? "int8" : "float"}[${dim}]`;
  const binaryRescoreSchema = dtype === "binary"
    ? `CREATE VIRTUAL TABLE vectors_rescore USING vec0(embedding int8[${dim}]);`
    : "";
  db.exec(`
    DROP TABLE IF EXISTS reconcile_load;
    DROP TABLE IF EXISTS vectors_rescore;
    DROP TABLE IF EXISTS vectors;
    CREATE VIRTUAL TABLE vectors USING vec0(${vectorSchema});
    ${binaryRescoreSchema}
    CREATE TABLE reconcile_load (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
  `);
}

function seedVectors(db, dtype) {
  const insertSql = dtype === "float32"
    ? "INSERT INTO vectors(rowid, embedding) VALUES (?, ?)"
    : dtype === "int8"
      ? "INSERT INTO vectors(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))"
      : "INSERT INTO vectors(rowid, embedding) VALUES (?, vec_quantize_binary(?))";
  const insert = db.prepare(insertSql);
  const insertRescore = dtype === "binary"
    ? db.prepare("INSERT INTO vectors_rescore(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))")
    : null;
  const batchSize = 1_000;
  const txn = db.transaction((start) => {
    const end = Math.min(rowCount, start + batchSize - 1);
    for (let rowid = start; rowid <= end; rowid += 1) {
      const vector = vectorBuffer(rowid);
      insert.run(BigInt(rowid), vector);
      if (insertRescore) insertRescore.run(BigInt(rowid), vector);
    }
  });
  for (let start = 1; start <= rowCount; start += batchSize) {
    txn(start);
    if (start % 50_000 === 1) {
      console.log(`[phase5-vec-scale] ${dtype} seeded ${Math.min(rowCount, start + batchSize - 1)}/${rowCount}`);
    }
  }
}

function measureQueries(db, dtype, count) {
  const statement = createKnnStatement(db, dtype);
  const times = [];
  const candidateCounts = [];
  for (let i = 0; i < count; i += 1) {
    const queryId = ((i * 7919) % rowCount) + 1;
    const query = vectorBuffer(queryId);
    const started = performance.now();
    const rows = runKnn(statement, dtype, query);
    times.push(performance.now() - started);
    candidateCounts.push(rows.length);
  }
  return summarizeTimes(times, { candidateCounts });
}

function measureDuringWriteLoad(db, dtype, count) {
  const insertLoad = db.prepare("INSERT INTO reconcile_load(payload) VALUES (?)");
  const writeTxn = db.transaction((i) => {
    for (let n = 0; n < 50; n += 1) insertLoad.run(`load-${i}-${n}-${"x".repeat(256)}`);
  });
  const statement = createKnnStatement(db, dtype);
  const times = [];
  for (let i = 0; i < count; i += 1) {
    writeTxn(i);
    const started = performance.now();
    runKnn(statement, dtype, vectorBuffer(((i * 3571) % rowCount) + 1));
    times.push(performance.now() - started);
  }
  return summarizeTimes(times, { note: "interleaved short WAL writes in the same process; cross-process WAL contention is gated by 0C" });
}

function createKnnStatement(db, dtype) {
  if (dtype === "float32") {
    return db.prepare(`
      SELECT rowid, distance
      FROM vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT 20
    `);
  }
  if (dtype === "int8") {
    return db.prepare(`
      SELECT rowid, distance
      FROM vectors
      WHERE embedding MATCH vec_quantize_int8(?, 'unit')
      ORDER BY distance
      LIMIT 20
    `);
  }
  return {
    coarse: db.prepare(`
      SELECT rowid, distance AS coarseDistance
      FROM vectors
      WHERE embedding MATCH vec_quantize_binary(?)
      ORDER BY distance
      LIMIT ${20 * binaryOversampleFactor}
    `),
    rescore: db.prepare("SELECT embedding AS embeddingRescore FROM vectors_rescore WHERE rowid = ?"),
    quantize: db.prepare("SELECT vec_quantize_int8(?, 'unit') AS vector"),
  };
}

function runKnn(statement, dtype, query) {
  if (dtype !== "binary") return statement.all(query);
  const rows = statement.coarse.all(query);
  const queryVector = statement.quantize.get(query)?.vector;
  if (!Buffer.isBuffer(queryVector)) throw new Error("binary int8 query quantization did not return a buffer");
  return rows
    .map((row) => {
      const stored = statement.rescore.get(row.rowid)?.embeddingRescore;
      if (!Buffer.isBuffer(stored)) throw new Error(`missing binary rescore row ${String(row.rowid)}`);
      return {
        ...row,
        rescoredDistance: int8L2Distance(stored, queryVector),
      };
    })
    .sort((a, b) => a.rescoredDistance - b.rescoredDistance || Number(a.rowid) - Number(b.rowid))
    .slice(0, 20);
}

function vectorBuffer(rowid) {
  return Buffer.from(vectorArray(rowid).buffer);
}

function vectorArray(rowid) {
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

function int8L2Distance(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new Error("binary rescore expected stored int8 buffers");
  }
  if (a.length !== b.length) {
    throw new Error(`binary rescore dimension mismatch: ${a.length} != ${b.length}`);
  }
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a.readInt8(i) - b.readInt8(i);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

async function measureDbBytes(dbPath) {
  const db = await fileSize(dbPath);
  const wal = await fileSize(`${dbPath}-wal`);
  const shm = await fileSize(`${dbPath}-shm`);
  return { db, wal, shm, total: db + wal + shm };
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function summarizeTimes(times, extra = {}) {
  return {
    count: times.length,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    maxMs: Math.max(...times),
    ...extra,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function renderEvidence(result) {
  const memoryRows = result.runs.map((run) => `| ${run.dtype} | ${formatBytes(run.memory.rss)} | ${formatBytes(run.memory.heapUsed)} | ${formatBytes(run.memory.external)} | ${formatBytes(run.memory.arrayBuffers)} |`).join("\n");
  return `# Phase 5 Task 0B sqlite-vec Scale - ${defaultDate}

## Scope

- Synthetic rows: ${result.rowCount}
- Dimension: ${result.dim}
- Query samples per mode: ${result.queryCount}
- Binary oversample factor: ${result.binaryOversampleFactor}
- Reopen method: ${result.reopenMethod}
- Cross-process write contention: ${result.crossProcessWriteContention}
- Binary mode storage: bit coarse vec0 table plus same-rowid stored int8 rescore vec0 table; binary rescore does not regenerate vectors from rowid.
- No all-vectors heap load: enforced. RSS <= ${formatBytes(result.memoryBounds.maxRssBytes)} and heapUsed <= ${formatBytes(result.memoryBounds.maxHeapBytes)} per dtype run.

## Results

| dtype | seed | warm p95 | reopen p95 | same-process write p95 | DB | WAL | SHM | total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${result.runs.map((run) => `| ${run.dtype} | ${formatMs(run.seedMs)} | ${formatMs(run.warm.p95Ms)} | ${formatMs(run.reopen.p95Ms)} | ${formatMs(run.sameProcessWrite.p95Ms)} | ${formatBytes(run.finalBytes.db)} | ${formatBytes(run.finalBytes.wal)} | ${formatBytes(run.finalBytes.shm)} | ${formatBytes(run.finalBytes.total)} |`).join("\n")}

## Memory Bound

| dtype | RSS | heapUsed | external | arrayBuffers |
| --- | ---: | ---: | ---: | ---: |
${memoryRows}

## Artifacts

- Result JSON: \`${resultJson}\`
`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function readPositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function assertMemoryBound(dtype, memory) {
  if (memory.rss > maxRssBytes) {
    throw new Error(`${dtype} RSS ${memory.rss} exceeded ${maxRssBytes}; possible mmap/page-cache or native memory blowup`);
  }
  if (memory.heapUsed > maxHeapBytes) {
    throw new Error(`${dtype} heapUsed ${memory.heapUsed} exceeded ${maxHeapBytes}; no-all-vectors-heap-load invariant failed`);
  }
}
