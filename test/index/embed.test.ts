import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import {
  VectorEmbeddingError,
  createEmbeddingProfileFingerprint,
  ingestChunkVector,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
} from "../../src/index/embed.js";

describe("index vector ingestion", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      const db = openDbs.pop();
      if (db) db.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("ingests one chunk into bit and int8 vec0 rows plus mapping and coverage", async () => {
    const indexDb = await openTempIndexDb();
    const chunkRowid = insertChunk(indexDb, "wiki/a.md", "Vector search keeps lexical indexing fast.");
    const profile = profileFingerprint();
    const embedder = fakeEmbedder([vector(0)]);

    const result = await ingestChunkVector({
      database: indexDb.database,
      chunkRowid,
      profile,
      embedder,
    });

    expect(result.status).toBe("embedded");
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
    expect(indexDb.database.prepare("SELECT rowid FROM chunk_vectors_bin").get()).toEqual({ rowid: chunkRowid });
    expect(indexDb.database.prepare("SELECT rowid FROM chunk_vectors_i8").get()).toEqual({ rowid: chunkRowid });
    expect(
      indexDb.database
        .prepare("SELECT chunkRowid, profileId, coarseRowid, status, embeddedPayloadHash FROM chunk_vectors")
        .get(),
    ).toEqual({
      chunkRowid,
      profileId: profile.profileId,
      coarseRowid: chunkRowid,
      status: "embedded",
      embeddedPayloadHash: result.embeddedPayloadHash,
    });
    expect(indexDb.database.prepare("SELECT eligible, embedded, failed, skipped FROM vector_coverage").get()).toEqual({
      eligible: 1,
      embedded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("reuses an unchanged chunk without calling the embedder again", async () => {
    const indexDb = await openTempIndexDb();
    const chunkRowid = insertChunk(indexDb, "wiki/reuse.md", "Do not recompute unchanged payloads.");
    const profile = profileFingerprint();
    const embedder = fakeEmbedder([vector(1)]);

    const first = await ingestChunkVector({ database: indexDb.database, chunkRowid, profile, embedder });
    embedder.embed.mockRejectedValueOnce(new Error("embedder should not be called for unchanged payload"));
    const second = await ingestChunkVector({ database: indexDb.database, chunkRowid, profile, embedder });

    expect(first.status).toBe("embedded");
    expect(second.status).toBe("reused");
    expect(second.embeddedPayloadHash).toBe(first.embeddedPayloadHash);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
  });

  it("drops and rebuilds vector rows when the active profile fingerprint changes", async () => {
    const indexDb = await openTempIndexDb();
    const chunkRowid = insertChunk(indexDb, "wiki/profile.md", "A changed profile must rebuild vector storage.");
    const firstProfile = profileFingerprint({ modelHash: "model-a" });
    const secondProfile = profileFingerprint({ modelHash: "model-b" });
    const embedder = fakeEmbedder([vector(2), vector(3)]);

    await ingestChunkVector({ database: indexDb.database, chunkRowid, profile: firstProfile, embedder });
    const result = await ingestChunkVector({ database: indexDb.database, chunkRowid, profile: secondProfile, embedder });

    expect(result.status).toBe("embedded");
    expect(embedder.embed).toHaveBeenCalledTimes(2);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
    expect(
      indexDb.database.prepare<[string]>("SELECT count(*) AS count FROM chunk_vectors WHERE profileId = ?").get(firstProfile.profileId),
    ).toEqual({ count: 0 });
    expect(
      indexDb.database.prepare("SELECT profileId, status FROM chunk_vectors").get(),
    ).toEqual({ profileId: secondProfile.profileId, status: "embedded" });
    expect(indexDb.database.prepare("SELECT profileId FROM vector_coverage").get()).toEqual({
      profileId: secondProfile.profileId,
    });
  });

  it("records typed failures when the embedder is unavailable", async () => {
    const indexDb = await openTempIndexDb();
    const chunkRowid = insertChunk(indexDb, "wiki/fail.md", "Missing model should not crash the index DB.");
    const profile = profileFingerprint();
    const embedder = {
      embed: vi.fn(async () => {
        throw new VectorEmbeddingError("model-unavailable", "model assets missing");
      }),
    } satisfies EmbedClient & { embed: ReturnType<typeof vi.fn> };

    const result = await ingestChunkVector({ database: indexDb.database, chunkRowid, profile, embedder });

    expect(result).toEqual({
      status: "failed",
      failureCode: "model-unavailable",
      embeddedPayloadHash: expect.any(String),
    });
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(0);
    expect(indexDb.database.prepare("SELECT status, failureReason FROM chunk_vectors").get()).toEqual({
      status: "failed",
      failureReason: "model-unavailable",
    });
    expect(indexDb.database.prepare("SELECT eligible, embedded, failed, skipped FROM vector_coverage").get()).toEqual({
      eligible: 1,
      embedded: 0,
      failed: 1,
      skipped: 0,
    });
  });

  async function openTempIndexDb(): Promise<IndexDb> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-index-embed-"));
    const indexDb = openIndexDb(join(tempDir, "index.db"));
    openDbs.push(indexDb);
    return indexDb;
  }

  function insertChunk(indexDb: IndexDb, relPath: string, text: string): number {
    const db = indexDb.database;
    db.prepare("INSERT INTO files(relPath, generation) VALUES(?, 1)").run(relPath);
    const result = db
      .prepare(
        "INSERT INTO chunks(chunkId, relPath, ordinal, headingPath, byteStart, byteEnd, text, textHash, generation) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(`${relPath}#0`, relPath, 0, "Heading", 0, text.length, text, `hash-${relPath}`, 1) as {
      readonly lastInsertRowid: number | bigint;
    };
    return Number(result.lastInsertRowid);
  }

  function profileFingerprint(overrides: Partial<Omit<EmbeddingProfileFingerprint, "profileId">> = {}): EmbeddingProfileFingerprint {
    return createEmbeddingProfileFingerprint({
      provider: "local",
      runtime: "onnxruntime-node",
      runtimeVersion: "1.22.0",
      modelId: "BAAI/bge-small-en-v1.5",
      modelRevision: "refs/pr/5",
      modelHash: "model-a",
      tokenizerHash: "tokenizer-a",
      pooling: "cls",
      normalization: "l2",
      dtype: "binary-int8",
      dimension: 384,
      prefixStrategy: "bge-passage",
      chunkerVersion: "phase3-v1",
      payloadRecipe: "heading-path-v1",
      maxTokenPolicy: "truncate-512",
      ...overrides,
    });
  }

  function fakeEmbedder(vectors: Float32Array[]): EmbedClient & { embed: ReturnType<typeof vi.fn> } {
    const pending = [...vectors];
    return {
      embed: vi.fn(async () => {
        const next = pending.shift();
        if (!next) throw new Error("test embedder exhausted");
        return [next];
      }),
    } satisfies EmbedClient & { embed: ReturnType<typeof vi.fn> };
  }

  function vector(index: number): Float32Array {
    const values = new Float32Array(384);
    values[index] = 1;
    return values;
  }

  function countRows(indexDb: IndexDb, table: "chunk_vectors_bin" | "chunk_vectors_i8"): number {
    return (indexDb.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  }
});
