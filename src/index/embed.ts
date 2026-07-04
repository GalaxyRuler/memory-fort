import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  createPhase5LocalEmbedder,
  type Phase5LocalEmbedder,
  type Phase5ModelManifest,
} from "../dashboard/phase5-local-embedder.js";
import { createVectorTablesSql, type SqliteDatabase } from "./db.js";

const require = createRequire(import.meta.url);
const VECTOR_DIMENSION = 384;
const VECTOR_DTYPE = "binary-int8";

export type VectorStatus = "pending" | "embedded" | "failed" | "skipped";

export type VectorEmbeddingFailureCode =
  | "model-unavailable"
  | "tokenizer-failed"
  | "embed-timeout"
  | "rate-limited"
  | "write-failed"
  | "dtype-dim-mismatch";

export interface EmbedClient {
  embed(texts: readonly string[], opts?: { readonly signal?: AbortSignal }): Promise<readonly Float32Array[]>;
}

export interface EmbeddingProfileFingerprint {
  readonly profileId: string;
  readonly provider: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly modelHash: string;
  readonly tokenizerHash: string;
  readonly pooling: string;
  readonly normalization: string;
  readonly dtype: string;
  readonly dimension: number;
  readonly prefixStrategy: string;
  readonly chunkerVersion: string;
  readonly payloadRecipe: string;
  readonly maxTokenPolicy: string;
}

export interface LocalBgeSmallEmbedClient extends EmbedClient {
  readonly profile: EmbeddingProfileFingerprint;
  readonly modelRoot: string;
  readonly loadTimeMs: number;
  readonly intraOpNumThreads: number;
  readonly interOpNumThreads: number;
}

export interface IngestChunkVectorOptions {
  readonly database: SqliteDatabase;
  readonly chunkRowid: number;
  readonly profile: EmbeddingProfileFingerprint;
  readonly embedder: EmbedClient;
  readonly nowMs?: number;
}

export interface IngestChunkVectorsBatchOptions {
  readonly database: SqliteDatabase;
  readonly chunkRowids: readonly number[];
  readonly profile: EmbeddingProfileFingerprint;
  readonly embedder: EmbedClient;
  readonly nowMs?: number;
}

export type IngestChunkVectorResult =
  | {
      readonly status: "embedded" | "reused";
      readonly coarseRowid: number;
      readonly embeddedPayloadHash: string;
    }
  | {
      readonly status: "stale";
      readonly embeddedPayloadHash: string;
    }
  | {
      readonly status: "failed";
      readonly failureCode: VectorEmbeddingFailureCode;
      readonly embeddedPayloadHash: string;
    };

interface ChunkPayloadRow {
  readonly rowid: number;
  readonly chunkId: string;
  readonly relPath: string;
  readonly headingPath: string | null;
  readonly text: string;
  readonly generation: number;
}

interface ExistingVectorRow {
  readonly coarseRowid: number;
  readonly embeddedPayloadHash: string | null;
  readonly status: VectorStatus;
}

interface CountRow {
  readonly count: number;
}

interface CoverageRow {
  readonly eligible: number;
  readonly embedded: number;
  readonly failed: number;
  readonly skipped: number;
}

interface MetaRow {
  readonly value: string | null;
}

export class VectorEmbeddingError extends Error {
  readonly code: VectorEmbeddingFailureCode;

  constructor(code: VectorEmbeddingFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VectorEmbeddingError";
    this.code = code;
  }
}

export async function createLocalBgeSmallEmbedClient(opts: {
  readonly modelRoot?: string;
  readonly intraOpNumThreads?: number;
  readonly interOpNumThreads?: number;
} = {}): Promise<LocalBgeSmallEmbedClient> {
  let embedder: Phase5LocalEmbedder;
  try {
    embedder = await createPhase5LocalEmbedder(opts);
  } catch (error) {
    throw classifyLocalEmbedderCreateError(error);
  }

  const profile = createLocalBgeSmallProfile(embedder.manifest);
  return {
    profile,
    modelRoot: embedder.modelRoot,
    loadTimeMs: embedder.loadTimeMs,
    intraOpNumThreads: embedder.intraOpNumThreads,
    interOpNumThreads: embedder.interOpNumThreads,
    embed: async (texts, embedOpts) => {
      if (embedOpts?.signal?.aborted) {
        throw new VectorEmbeddingError("embed-timeout", "embedding request was aborted before execution");
      }
      const batch = await embedder.embed(texts);
      if (embedOpts?.signal?.aborted) {
        throw new VectorEmbeddingError("embed-timeout", "embedding request was aborted after execution");
      }
      return batch.vectors.map((vector) => Float32Array.from(vector));
    },
  };
}

export function createEmbeddingProfileFingerprint(
  input: Omit<EmbeddingProfileFingerprint, "profileId">,
): EmbeddingProfileFingerprint {
  const payload = normalizeProfilePayload(input);
  const profileId = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return { profileId, ...payload };
}

export async function ingestChunkVector(opts: IngestChunkVectorOptions): Promise<IngestChunkVectorResult> {
  const { database, chunkRowid, profile, embedder } = opts;
  assertSupportedProfile(profile);
  activateEmbeddingProfile(database, profile, opts.nowMs);

  const chunk = readChunkPayload(database, chunkRowid);
  const payload = buildEmbeddedPayload(chunk);
  const embeddedPayloadHash = sha256Text(payload);
  const existing = readExistingVector(database, chunkRowid, profile.profileId);
  if (
    existing?.status === "embedded" &&
    existing.embeddedPayloadHash === embeddedPayloadHash &&
    vectorRowsExist(database, existing.coarseRowid)
  ) {
    return { status: "reused", coarseRowid: existing.coarseRowid, embeddedPayloadHash };
  }

  let vectors: readonly Float32Array[];
  try {
    vectors = await embedder.embed([payload]);
  } catch (error) {
    const failureCode = classifyEmbeddingFailure(error);
    return writeFailedVector(database, {
      chunk,
      profile,
      embeddedPayloadHash,
      failureCode,
      nowMs: opts.nowMs,
    });
  }

  const vector = vectors[0];
  if (!(vector instanceof Float32Array) || vector.length !== profile.dimension) {
    return writeFailedVector(database, {
      chunk,
      profile,
      embeddedPayloadHash,
      failureCode: "dtype-dim-mismatch",
      nowMs: opts.nowMs,
    });
  }

  try {
    return writeEmbeddedVector(database, {
      chunk,
      profile,
      embeddedPayloadHash,
      vector,
      nowMs: opts.nowMs,
    });
  } catch {
    return writeFailedVector(database, {
      chunk,
      profile,
      embeddedPayloadHash,
      failureCode: "write-failed",
      nowMs: opts.nowMs,
    });
  }
}

export async function ingestChunkVectorsBatch(
  opts: IngestChunkVectorsBatchOptions,
): Promise<IngestChunkVectorResult[]> {
  const { database, profile, embedder } = opts;
  assertSupportedProfile(profile);
  activateEmbeddingProfile(database, profile, opts.nowMs);

  const results = new Map<number, IngestChunkVectorResult>();
  const pending: Array<{
    readonly order: number;
    readonly chunk: ChunkPayloadRow;
    readonly payload: string;
    readonly embeddedPayloadHash: string;
  }> = [];

  opts.chunkRowids.forEach((chunkRowid, order) => {
    const chunk = readChunkPayload(database, chunkRowid);
    const payload = buildEmbeddedPayload(chunk);
    const embeddedPayloadHash = sha256Text(payload);
    const existing = readExistingVector(database, chunkRowid, profile.profileId);
    if (
      existing?.status === "embedded" &&
      existing.embeddedPayloadHash === embeddedPayloadHash &&
      vectorRowsExist(database, existing.coarseRowid)
    ) {
      results.set(order, {
        status: "reused",
        coarseRowid: existing.coarseRowid,
        embeddedPayloadHash,
      });
      return;
    }
    pending.push({ order, chunk, payload, embeddedPayloadHash });
  });

  if (pending.length > 0) {
    let vectors: readonly Float32Array[];
    try {
      vectors = await embedder.embed(pending.map((item) => item.payload));
    } catch (error) {
      const failureCode = classifyEmbeddingFailure(error);
      for (const item of pending) {
        results.set(item.order, writeFailedVector(database, {
          chunk: item.chunk,
          profile,
          embeddedPayloadHash: item.embeddedPayloadHash,
          failureCode,
          nowMs: opts.nowMs,
        }));
      }
      return orderedBatchResults(results, opts.chunkRowids.length);
    }

    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]!;
      const vector = vectors[index];
      if (!(vector instanceof Float32Array) || vector.length !== profile.dimension) {
        results.set(item.order, writeFailedVector(database, {
          chunk: item.chunk,
          profile,
          embeddedPayloadHash: item.embeddedPayloadHash,
          failureCode: "dtype-dim-mismatch",
          nowMs: opts.nowMs,
        }));
        continue;
      }
      try {
        results.set(item.order, writeEmbeddedVector(database, {
          chunk: item.chunk,
          profile,
          embeddedPayloadHash: item.embeddedPayloadHash,
          vector,
          nowMs: opts.nowMs,
        }));
      } catch {
        results.set(item.order, writeFailedVector(database, {
          chunk: item.chunk,
          profile,
          embeddedPayloadHash: item.embeddedPayloadHash,
          failureCode: "write-failed",
          nowMs: opts.nowMs,
        }));
      }
    }
  }

  return orderedBatchResults(results, opts.chunkRowids.length);
}

function orderedBatchResults(
  results: ReadonlyMap<number, IngestChunkVectorResult>,
  count: number,
): IngestChunkVectorResult[] {
  const ordered: IngestChunkVectorResult[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = results.get(index);
    if (!result) throw new Error(`missing vector batch result at index ${index}`);
    ordered.push(result);
  }
  return ordered;
}

function createLocalBgeSmallProfile(manifest: Phase5ModelManifest): EmbeddingProfileFingerprint {
  return createEmbeddingProfileFingerprint({
    provider: "local",
    runtime: "onnxruntime-node",
    runtimeVersion: readOnnxRuntimeVersion(),
    modelId: manifest.modelId,
    modelRevision: manifest.modelRevision,
    modelHash: readManifestAssetHash(manifest, "onnx/model.onnx"),
    tokenizerHash: readManifestAssetHash(manifest, "vocab.txt"),
    pooling: manifest.pooling,
    normalization: manifest.normalization,
    dtype: VECTOR_DTYPE,
    dimension: manifest.dimension,
    prefixStrategy: "bge-passage",
    chunkerVersion: "phase3-v1",
    payloadRecipe: "heading-path-v1",
    maxTokenPolicy: `truncate-${manifest.maxTokens}`,
  });
}

function activateEmbeddingProfile(
  database: SqliteDatabase,
  profile: EmbeddingProfileFingerprint,
  nowMs = Date.now(),
): void {
  const activeProfileId = readMeta(database, "activeEmbeddingProfileId");
  database.exec("BEGIN IMMEDIATE");
  try {
    insertEmbeddingProfile(database, profile, nowMs);
    if (activeProfileId !== null && activeProfileId !== profile.profileId) {
      resetVectorStorage(database, profile.dimension);
    }
    writeMeta(database, "activeEmbeddingProfileId", profile.profileId);
    writeMeta(database, "activeEmbeddingProfileFingerprint", profileFingerprintJson(profile));
    refreshVectorCoverage(database, profile.profileId, nowMs);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function insertEmbeddingProfile(database: SqliteDatabase, profile: EmbeddingProfileFingerprint, nowMs: number): void {
  database
    .prepare(
      `INSERT INTO embedding_profiles(
        profileId, provider, runtime, runtimeVersion, modelId, modelRevision,
        modelHash, tokenizerHash, pooling, normalization, dtype, dimension,
        prefixStrategy, chunkerVersion, payloadRecipe, maxTokenPolicy, fingerprintJson, createdAt
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profileId) DO UPDATE SET fingerprintJson = excluded.fingerprintJson`,
    )
    .run(
      profile.profileId,
      profile.provider,
      profile.runtime,
      profile.runtimeVersion,
      profile.modelId,
      profile.modelRevision,
      profile.modelHash,
      profile.tokenizerHash,
      profile.pooling,
      profile.normalization,
      profile.dtype,
      profile.dimension,
      profile.prefixStrategy,
      profile.chunkerVersion,
      profile.payloadRecipe,
      profile.maxTokenPolicy,
      profileFingerprintJson(profile),
      nowMs,
    );
}

function resetVectorStorage(database: SqliteDatabase, dimension: number): void {
  database.exec(`
    DELETE FROM chunk_vectors;
    DELETE FROM vector_coverage;
    DROP TABLE IF EXISTS chunk_vectors_bin;
    DROP TABLE IF EXISTS chunk_vectors_i8;
    ${createVectorTablesSql(dimension)}
  `);
}

function readChunkPayload(database: SqliteDatabase, chunkRowid: number): ChunkPayloadRow {
  const row = database
    .prepare<[number], ChunkPayloadRow>(
      "SELECT rowid, chunkId, relPath, headingPath, text, generation FROM chunks WHERE rowid = ?",
    )
    .get(chunkRowid);
  if (!row) throw new Error(`chunk row ${chunkRowid} does not exist`);
  return row;
}

function readChunkPayloadIfExists(database: SqliteDatabase, chunkRowid: number): ChunkPayloadRow | undefined {
  return database
    .prepare<[number], ChunkPayloadRow>(
      "SELECT rowid, chunkId, relPath, headingPath, text, generation FROM chunks WHERE rowid = ?",
    )
    .get(chunkRowid);
}

function buildEmbeddedPayload(chunk: ChunkPayloadRow): string {
  const heading = chunk.headingPath?.trim();
  return heading ? `${heading}\n\n${chunk.text}` : chunk.text;
}

function readExistingVector(
  database: SqliteDatabase,
  chunkRowid: number,
  profileId: string,
): ExistingVectorRow | undefined {
  return database
    .prepare<[number, string], ExistingVectorRow>(
      "SELECT coarseRowid, embeddedPayloadHash, status FROM chunk_vectors WHERE chunkRowid = ? AND profileId = ?",
    )
    .get(chunkRowid, profileId);
}

function vectorRowsExist(database: SqliteDatabase, coarseRowid: number): boolean {
  const bin = database
    .prepare<[number], CountRow>("SELECT count(*) AS count FROM chunk_vectors_bin WHERE rowid = ?")
    .get(coarseRowid)?.count ?? 0;
  const i8 = database
    .prepare<[number], CountRow>("SELECT count(*) AS count FROM chunk_vectors_i8 WHERE rowid = ?")
    .get(coarseRowid)?.count ?? 0;
  return bin === 1 && i8 === 1;
}

function writeEmbeddedVector(
  database: SqliteDatabase,
  opts: {
    readonly chunk: ChunkPayloadRow;
    readonly profile: EmbeddingProfileFingerprint;
    readonly embeddedPayloadHash: string;
    readonly vector: Float32Array;
    readonly nowMs?: number;
  },
): IngestChunkVectorResult {
  const nowMs = opts.nowMs ?? Date.now();
  const coarseRowid = opts.chunk.rowid;
  const vectorBuffer = float32VectorBuffer(opts.vector);

  database.exec("BEGIN IMMEDIATE");
  try {
    if (!isChunkStillCurrent(database, opts.chunk, opts.profile, opts.embeddedPayloadHash)) {
      database.exec("COMMIT");
      return { status: "stale", embeddedPayloadHash: opts.embeddedPayloadHash };
    }
    deleteVectorRows(database, opts.chunk.rowid, opts.profile.profileId, coarseRowid);
    database
      .prepare<[bigint, Buffer]>("INSERT INTO chunk_vectors_bin(rowid, embedding) VALUES (?, vec_quantize_binary(?))")
      .run(BigInt(coarseRowid), vectorBuffer);
    database
      .prepare<[bigint, Buffer]>("INSERT INTO chunk_vectors_i8(rowid, embedding) VALUES (?, vec_quantize_int8(?, 'unit'))")
      .run(BigInt(coarseRowid), vectorBuffer);
    database
      .prepare(
        `INSERT INTO chunk_vectors(
          chunkRowid, profileId, coarseRowid, generation, status, embeddedPayloadHash, failureReason, updatedAt
        ) VALUES(?,?,?,?,?,?,NULL,?)`,
      )
      .run(
        opts.chunk.rowid,
        opts.profile.profileId,
        coarseRowid,
        opts.chunk.generation,
        "embedded",
        opts.embeddedPayloadHash,
        nowMs,
      );
    refreshVectorCoverage(database, opts.profile.profileId, nowMs);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }

  return { status: "embedded", coarseRowid, embeddedPayloadHash: opts.embeddedPayloadHash };
}

function writeFailedVector(
  database: SqliteDatabase,
  opts: {
    readonly chunk: ChunkPayloadRow;
    readonly profile: EmbeddingProfileFingerprint;
    readonly embeddedPayloadHash: string;
    readonly failureCode: VectorEmbeddingFailureCode;
    readonly nowMs?: number;
  },
): IngestChunkVectorResult {
  const nowMs = opts.nowMs ?? Date.now();
  const coarseRowid = opts.chunk.rowid;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!isChunkStillCurrent(database, opts.chunk, opts.profile, opts.embeddedPayloadHash)) {
      database.exec("COMMIT");
      return { status: "stale", embeddedPayloadHash: opts.embeddedPayloadHash };
    }
    deleteVectorRows(database, opts.chunk.rowid, opts.profile.profileId, coarseRowid);
    database
      .prepare(
        `INSERT INTO chunk_vectors(
          chunkRowid, profileId, coarseRowid, generation, status, embeddedPayloadHash, failureReason, updatedAt
        ) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        opts.chunk.rowid,
        opts.profile.profileId,
        coarseRowid,
        opts.chunk.generation,
        "failed",
        opts.embeddedPayloadHash,
        opts.failureCode,
        nowMs,
      );
    refreshVectorCoverage(database, opts.profile.profileId, nowMs);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  return {
    status: "failed",
    failureCode: opts.failureCode,
    embeddedPayloadHash: opts.embeddedPayloadHash,
  };
}

function deleteVectorRows(
  database: SqliteDatabase,
  chunkRowid: number,
  profileId: string,
  coarseRowid: number,
): void {
  const existing = readExistingVector(database, chunkRowid, profileId);
  const rowids = new Set([coarseRowid]);
  if (existing) rowids.add(existing.coarseRowid);
  database.prepare<[number, string]>("DELETE FROM chunk_vectors WHERE chunkRowid = ? AND profileId = ?").run(chunkRowid, profileId);
  for (const rowid of rowids) {
    database.prepare<[bigint]>("DELETE FROM chunk_vectors_bin WHERE rowid = ?").run(BigInt(rowid));
    database.prepare<[bigint]>("DELETE FROM chunk_vectors_i8 WHERE rowid = ?").run(BigInt(rowid));
  }
}

function isChunkStillCurrent(
  database: SqliteDatabase,
  original: ChunkPayloadRow,
  profile: EmbeddingProfileFingerprint,
  embeddedPayloadHash: string,
): boolean {
  if (readMeta(database, "activeEmbeddingProfileId") !== profile.profileId) return false;
  const current = readChunkPayloadIfExists(database, original.rowid);
  if (!current) return false;
  return (
    current.chunkId === original.chunkId &&
    current.relPath === original.relPath &&
    current.generation === original.generation &&
    sha256Text(buildEmbeddedPayload(current)) === embeddedPayloadHash
  );
}

function refreshVectorCoverage(database: SqliteDatabase, profileId: string, nowMs: number): void {
  const coverage = database
    .prepare<[string], CoverageRow>(
      `SELECT
        (SELECT count(*) FROM chunks) AS eligible,
        COALESCE(SUM(CASE WHEN status = 'embedded' THEN 1 ELSE 0 END), 0) AS embedded,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped
      FROM chunk_vectors
      WHERE profileId = ?`,
    )
    .get(profileId) ?? { eligible: 0, embedded: 0, failed: 0, skipped: 0 };
  database
    .prepare(
      `INSERT INTO vector_coverage(profileId, eligible, embedded, failed, skipped, updatedAt)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(profileId) DO UPDATE SET
        eligible = excluded.eligible,
        embedded = excluded.embedded,
        failed = excluded.failed,
        skipped = excluded.skipped,
        updatedAt = excluded.updatedAt`,
    )
    .run(profileId, coverage.eligible, coverage.embedded, coverage.failed, coverage.skipped, nowMs);
}

function assertSupportedProfile(profile: EmbeddingProfileFingerprint): void {
  if (profile.dimension !== VECTOR_DIMENSION) {
    throw new VectorEmbeddingError("dtype-dim-mismatch", `expected ${VECTOR_DIMENSION}-dim profile, got ${profile.dimension}`);
  }
  if (profile.dtype !== VECTOR_DTYPE) {
    throw new VectorEmbeddingError("dtype-dim-mismatch", `expected ${VECTOR_DTYPE} profile dtype, got ${profile.dtype}`);
  }
}

function classifyLocalEmbedderCreateError(error: unknown): VectorEmbeddingError {
  if (error instanceof VectorEmbeddingError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/vocab|tokenizer|token/i.test(message)) {
    return new VectorEmbeddingError("tokenizer-failed", message, error);
  }
  return new VectorEmbeddingError("model-unavailable", message, error);
}

function classifyEmbeddingFailure(error: unknown): VectorEmbeddingFailureCode {
  if (error instanceof VectorEmbeddingError) return error.code;
  if (error instanceof Error && /timeout|aborted|abort/i.test(error.message)) return "embed-timeout";
  if (error instanceof Error && /429|rate/i.test(error.message)) return "rate-limited";
  if (error instanceof Error && /dimension|dtype|shape/i.test(error.message)) return "dtype-dim-mismatch";
  return "model-unavailable";
}

function readManifestAssetHash(manifest: Phase5ModelManifest, path: string): string {
  const asset = manifest.assets.find((entry) => entry.path.replace(/\\/g, "/") === path);
  if (!asset) throw new VectorEmbeddingError("model-unavailable", `model manifest missing asset ${path}`);
  return asset.sha256;
}

function readOnnxRuntimeVersion(): string {
  const pkg = require("onnxruntime-node/package.json") as { readonly version?: string };
  return typeof pkg.version === "string" ? pkg.version : "unknown";
}

function readMeta(database: SqliteDatabase, key: string): string | null {
  try {
    return database.prepare<[string], MetaRow>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  } catch (error) {
    if (error instanceof Error && /no such table: meta/i.test(error.message)) return null;
    throw error;
  }
}

function writeMeta(database: SqliteDatabase, key: string, value: string): void {
  database
    .prepare<[string, string]>("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function normalizeProfilePayload(
  input: Omit<EmbeddingProfileFingerprint, "profileId">,
): Omit<EmbeddingProfileFingerprint, "profileId"> {
  return {
    provider: input.provider,
    runtime: input.runtime,
    runtimeVersion: input.runtimeVersion,
    modelId: input.modelId,
    modelRevision: input.modelRevision,
    modelHash: input.modelHash,
    tokenizerHash: input.tokenizerHash,
    pooling: input.pooling,
    normalization: input.normalization,
    dtype: input.dtype,
    dimension: input.dimension,
    prefixStrategy: input.prefixStrategy,
    chunkerVersion: input.chunkerVersion,
    payloadRecipe: input.payloadRecipe,
    maxTokenPolicy: input.maxTokenPolicy,
  };
}

function profileFingerprintJson(profile: EmbeddingProfileFingerprint): string {
  const { profileId: _profileId, ...payload } = profile;
  return canonicalJson(payload);
}

function canonicalJson(value: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function float32VectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
