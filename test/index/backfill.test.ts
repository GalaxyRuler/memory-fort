import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { backfillVectors } from "../../src/index/backfill.js";
import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import {
  createEmbeddingProfileFingerprint,
  ingestChunkVector,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
} from "../../src/index/embed.js";
import { reconcileIndex } from "../../src/index/reconcile.js";

describe("vector backfill", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("keeps lexical search queryable before a slow vector backfill finishes", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/indexed.md", "# Indexed\n\nneedle lexical first");
    await reconcileIndex(indexDb, vaultRoot);
    const embedder = deferredEmbedder();

    const backfill = backfillVectors(indexDb.database, {
      embedder,
      profile: profileFingerprint(),
      batchSize: 1,
      nowMs: () => 123,
    });
    await until(() => embedder.embed.mock.calls.length === 1);

    expect(searchChunkTexts(indexDb, "needle")).toEqual(["# Indexed\n\nneedle lexical first"]);
    expect(vectorCoverage(indexDb)).toEqual({ eligible: 1, embedded: 0, failed: 0, skipped: 0 });

    embedder.resolveNext(vector(0));
    await expect(backfill).resolves.toMatchObject({
      cancelled: false,
      processed: 1,
      embedded: 1,
    });
    expect(vectorCoverage(indexDb)).toEqual({ eligible: 1, embedded: 1, failed: 0, skipped: 0 });
  });

  it("skips a stale vector commit when a chunk changes while embedding is in flight", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/changing.md", "# Changing\n\nold payload");
    await reconcileIndex(indexDb, vaultRoot);
    const chunkRowid = onlyChunkRowid(indexDb);
    const embedder = deferredEmbedder();

    const backfill = backfillVectors(indexDb.database, {
      embedder,
      profile: profileFingerprint(),
      batchSize: 1,
      nowMs: () => 456,
    });
    await until(() => embedder.embed.mock.calls.length === 1);

    indexDb.database
      .prepare<[string, string, number]>("UPDATE chunks SET text = ?, textHash = ?, generation = generation + 1 WHERE rowid = ?")
      .run("new payload", "hash-new", chunkRowid);
    embedder.resolveNext(vector(1));

    await expect(backfill).resolves.toMatchObject({
      cancelled: false,
      processed: 1,
      embedded: 0,
      stale: 1,
    });
    expect(countRows(indexDb, "chunk_vectors")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(0);

    const resumedEmbedder = fakeEmbedder([vector(2)]);
    await expect(
      backfillVectors(indexDb.database, {
        embedder: resumedEmbedder,
        profile: profileFingerprint(),
        batchSize: 1,
      }),
    ).resolves.toMatchObject({ embedded: 1, stale: 0 });
    expect(resumedEmbedder.embed).toHaveBeenCalledTimes(1);
    expect(countRows(indexDb, "chunk_vectors")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
  });

  it("skips a stale vector commit when the active profile changes while embedding is in flight", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/profile-swap.md", "# Profile Swap\n\nsemantic payload");
    await reconcileIndex(indexDb, vaultRoot);
    const chunkRowid = onlyChunkRowid(indexDb);
    const profileA = profileFingerprint({ modelHash: "model-a" });
    const profileB = profileFingerprint({ modelHash: "model-b" });
    const embedder = deferredEmbedder();

    const backfill = backfillVectors(indexDb.database, {
      embedder,
      profile: profileA,
      batchSize: 1,
      nowMs: () => 500,
    });
    await until(() => embedder.embed.mock.calls.length === 1);

    await expect(
      ingestChunkVector({
        database: indexDb.database,
        chunkRowid,
        profile: profileB,
        embedder: fakeEmbedder([vector(8)]),
        nowMs: 501,
      }),
    ).resolves.toMatchObject({ status: "embedded" });
    expect(readMeta(indexDb, "activeEmbeddingProfileId")).toBe(profileB.profileId);

    embedder.resolveNext(vector(9));
    await expect(backfill).resolves.toMatchObject({
      cancelled: false,
      processed: 1,
      embedded: 0,
      stale: 1,
    });

    expect(selectVectorProfileIds(indexDb)).toEqual([profileB.profileId]);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
  });

  it("re-embeds a completed vector when the stored payload hash is stale", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/stale.md", "# Stale\n\noriginal payload");
    await reconcileIndex(indexDb, vaultRoot);
    const profile = profileFingerprint();
    const firstEmbedder = fakeEmbedder([vector(3)]);

    await expect(
      backfillVectors(indexDb.database, {
        embedder: firstEmbedder,
        profile,
        batchSize: 1,
        nowMs: () => 100,
      }),
    ).resolves.toMatchObject({ embedded: 1, stale: 0 });
    const firstHash = embeddedPayloadHash(indexDb);
    expect(readMeta(indexDb, "vectorGeneration")).toBe("1");

    const chunkRowid = onlyChunkRowid(indexDb);
    indexDb.database
      .prepare<[string, string, number]>("UPDATE chunks SET text = ?, textHash = ?, generation = generation + 1 WHERE rowid = ?")
      .run("changed payload", "hash-changed", chunkRowid);
    const secondEmbedder = fakeEmbedder([vector(4)]);

    await expect(
      backfillVectors(indexDb.database, {
        embedder: secondEmbedder,
        profile,
        batchSize: 1,
        nowMs: () => 200,
      }),
    ).resolves.toMatchObject({ embedded: 1, stale: 0 });

    expect(secondEmbedder.embed).toHaveBeenCalledTimes(1);
    expect(embeddedPayloadHash(indexDb)).not.toBe(firstHash);
    expect(readMeta(indexDb, "vectorGeneration")).toBe("2");
    expect(countRows(indexDb, "chunk_vectors")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);

    const noChangeEmbedder = fakeEmbedder([]);
    await expect(
      backfillVectors(indexDb.database, {
        embedder: noChangeEmbedder,
        profile,
        batchSize: 1,
      }),
    ).resolves.toMatchObject({ processed: 0, embedded: 0, stale: 0 });
    expect(noChangeEmbedder.embed).not.toHaveBeenCalled();
    expect(readMeta(indexDb, "vectorGeneration")).toBe("2");
  });

  it("embeds selected candidates in real batches when no shutdown signal is active", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nfirst vector");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nsecond vector");
    await writeVaultFile(vaultRoot, "wiki/c.md", "# C\n\nthird vector");
    await reconcileIndex(indexDb, vaultRoot);
    const embedder = batchFakeEmbedder([vector(1), vector(2), vector(3)]);

    await expect(
      backfillVectors(indexDb.database, {
        embedder,
        profile: profileFingerprint(),
        batchSize: 2,
        nowMs: () => 600,
      }),
    ).resolves.toMatchObject({
      cancelled: false,
      processed: 3,
      embedded: 3,
    });

    expect(embedder.embed).toHaveBeenCalledTimes(2);
    expect(embedder.embed.mock.calls.map(([texts]) => texts.length)).toEqual([2, 1]);
    expect(vectorCoverage(indexDb)).toEqual({ eligible: 3, embedded: 3, failed: 0, skipped: 0 });
  });

  it("stops after a shutdown signal and resumes remaining chunks on the next pass", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nfirst vector");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nsecond vector");
    await reconcileIndex(indexDb, vaultRoot);
    const profile = profileFingerprint();
    const controller = new AbortController();
    const abortingEmbedder = fakeEmbedder([vector(5), vector(6)], () => controller.abort());

    await expect(
      backfillVectors(indexDb.database, {
        embedder: abortingEmbedder,
        profile,
        batchSize: 2,
        signal: controller.signal,
        nowMs: () => 300,
      }),
    ).resolves.toMatchObject({
      cancelled: true,
      processed: 1,
      embedded: 1,
    });

    expect(abortingEmbedder.embed).toHaveBeenCalledTimes(1);
    expect(readMeta(indexDb, "vectorGeneration")).toBe("1");
    expect(vectorCoverage(indexDb)).toEqual({ eligible: 2, embedded: 1, failed: 0, skipped: 0 });

    const resumeEmbedder = fakeEmbedder([vector(7)]);
    await expect(
      backfillVectors(indexDb.database, {
        embedder: resumeEmbedder,
        profile,
        batchSize: 2,
        nowMs: () => 400,
      }),
    ).resolves.toMatchObject({ cancelled: false, processed: 1, embedded: 1 });

    expect(resumeEmbedder.embed).toHaveBeenCalledTimes(1);
    expect(readMeta(indexDb, "vectorGeneration")).toBe("2");
    expect(vectorCoverage(indexDb)).toEqual({ eligible: 2, embedded: 2, failed: 0, skipped: 0 });
  });

  async function createHarness(): Promise<{ vaultRoot: string; indexDb: IndexDb }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-backfill-"));
    const vaultRoot = join(tempDir, "vault");
    await mkdir(vaultRoot, { recursive: true });
    const indexDb = openIndexDb(join(tempDir, "index.db"));
    openDbs.push(indexDb);
    return { vaultRoot, indexDb };
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = join(vaultRoot, ...relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  function searchChunkTexts(indexDb: IndexDb, term: string): string[] {
    return (
      indexDb.database
        .prepare<[string], { text: string }>(
          "SELECT c.text AS text FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ? ORDER BY c.relPath",
        )
        .all(term)
    ).map((row) => row.text);
  }

  function vectorCoverage(indexDb: IndexDb): { eligible: number; embedded: number; failed: number; skipped: number } | undefined {
    return indexDb.database
      .prepare<[], { eligible: number; embedded: number; failed: number; skipped: number }>(
        "SELECT eligible, embedded, failed, skipped FROM vector_coverage",
      )
      .get();
  }

  function onlyChunkRowid(indexDb: IndexDb): number {
    return Number(indexDb.database.prepare<[], { rowid: number }>("SELECT rowid FROM chunks").get()?.rowid);
  }

  function embeddedPayloadHash(indexDb: IndexDb): string {
    return String(indexDb.database.prepare<[], { embeddedPayloadHash: string }>(
      "SELECT embeddedPayloadHash FROM chunk_vectors",
    ).get()?.embeddedPayloadHash);
  }

  function readMeta(indexDb: IndexDb, key: string): string | null {
    return indexDb.database.prepare<[string], { value: string | null }>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  function selectVectorProfileIds(indexDb: IndexDb): string[] {
    return (
      indexDb.database.prepare<[], { profileId: string }>("SELECT profileId FROM chunk_vectors ORDER BY profileId").all()
    ).map((row) => row.profileId);
  }

  function profileFingerprint(
    overrides: Partial<Omit<EmbeddingProfileFingerprint, "profileId">> = {},
  ): EmbeddingProfileFingerprint {
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

  function deferredEmbedder(): EmbedClient & {
    readonly embed: ReturnType<typeof vi.fn>;
    resolveNext(vector: Float32Array): void;
  } {
    const resolvers: Array<(vectors: readonly Float32Array[]) => void> = [];
    return {
      embed: vi.fn(async () => {
        return await new Promise<readonly Float32Array[]>((resolve) => {
          resolvers.push(resolve);
        });
      }),
      resolveNext: (nextVector: Float32Array) => {
        const resolve = resolvers.shift();
        if (!resolve) throw new Error("no pending embed request");
        resolve([nextVector]);
      },
    };
  }

  function fakeEmbedder(
    vectors: Float32Array[],
    afterEmbed?: (call: number) => void,
  ): EmbedClient & { embed: ReturnType<typeof vi.fn> } {
    const pending = [...vectors];
    let calls = 0;
    return {
      embed: vi.fn(async () => {
        calls += 1;
        const next = pending.shift();
        if (!next) throw new Error("test embedder exhausted");
        afterEmbed?.(calls);
        return [next];
      }),
    } satisfies EmbedClient & { embed: ReturnType<typeof vi.fn> };
  }

  function batchFakeEmbedder(vectors: Float32Array[]): EmbedClient & { embed: ReturnType<typeof vi.fn> } {
    const pending = [...vectors];
    return {
      embed: vi.fn(async (texts: readonly string[]) => {
        return texts.map(() => {
          const next = pending.shift();
          if (!next) throw new Error("test embedder exhausted");
          return next;
        });
      }),
    } satisfies EmbedClient & { embed: ReturnType<typeof vi.fn> };
  }

  function vector(index: number): Float32Array {
    const values = new Float32Array(384);
    values[index] = 1;
    return values;
  }

  function countRows(indexDb: IndexDb, table: "chunk_vectors" | "chunk_vectors_bin" | "chunk_vectors_i8"): number {
    return (indexDb.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not met");
  }
});
