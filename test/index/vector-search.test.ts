import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import {
  createEmbeddingProfileFingerprint,
  ingestChunkVector,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
} from "../../src/index/embed.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import {
  InlineSearchExecutor,
  fuseChunkRrf,
  twoStageVectorSearch,
  type ChunkRrfInput,
  type VectorSearchResult,
} from "../../src/index/vector-search.js";

describe("vector search", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("uses binary coarse KNN and stored int8 rescore to return the planted nearest chunk", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/alpha.md", "# Alpha\n\nfirst semantic payload");
    await writeVaultFile(vaultRoot, "wiki/beta.md", "# Beta\n\nsecond semantic payload");
    await writeVaultFile(vaultRoot, "wiki/gamma.md", "# Gamma\n\nthird semantic payload");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/alpha.md", profile, vector(0));
    await embedPath(indexDb, "wiki/beta.md", profile, vector(1));
    await embedPath(indexDb, "wiki/gamma.md", profile, vector(2));

    const results = twoStageVectorSearch(indexDb.database, {
      profile,
      queryVector: vector(1),
      k: 1,
      oversample: 3,
    });

    expect(results.map((result) => result.relPath)).toEqual(["wiki/beta.md"]);
    expect(results[0]).toMatchObject({ vectorRank: 1, distance: 0 });
  });

  it("fuses FTS and vector ranks at chunk level with parent dedup and deterministic ties", () => {
    const lexicalA = chunk(1, "a", "wiki/a.md");
    const lexicalB = chunk(2, "b", "wiki/b.md");
    const vectorB = vectorResult(chunk(2, "b", "wiki/b.md"));
    const vectorC = vectorResult(chunk(3, "c", "wiki/c.md"));

    const fused = fuseChunkRrf({
      lexical: [lexicalA, lexicalB],
      vector: [vectorB, vectorC],
    });

    expect(fused.map((result) => result.relPath)).toEqual(["wiki/b.md", "wiki/a.md", "wiki/c.md"]);
    expect(fused[0]?.sources).toEqual([
      { source: "lexical", rank: 2 },
      { source: "vector", rank: 1 },
    ]);

    const parentDeduped = fuseChunkRrf({
      lexical: [chunk(10, "parent-a", "wiki/parent.md")],
      vector: [vectorResult(chunk(11, "parent-b", "wiki/parent.md"))],
    });
    expect(parentDeduped.map((result) => result.relPath)).toEqual(["wiki/parent.md"]);

    const tied = fuseChunkRrf({
      lexical: [chunk(20, "z", "wiki/z.md")],
      vector: [vectorResult(chunk(21, "a", "wiki/a.md"))],
    });
    expect(tied.map((result) => result.relPath)).toEqual(["wiki/a.md", "wiki/z.md"]);
  });

  it("caches query vectors by normalized query and profile", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/vector.md", "# Vector\n\nsemantic payload");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/vector.md", profile, vector(0));
    let calls = 0;
    const embedder = {
      embed: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error("query cache missed");
        return [vector(0)];
      }),
    } satisfies EmbedClient;
    const executor = new InlineSearchExecutor({ indexDb, embedder, profile, k: 1 });

    await expect(executor.search({ query: "Semantic", limit: 1 })).resolves.toMatchObject({
      hybridMode: "lexical-plus-vector",
      results: [expect.objectContaining({ path: "wiki/vector.md" })],
    });
    await expect(executor.search({ query: " semantic ", limit: 1 })).resolves.toMatchObject({
      hybridMode: "lexical-plus-vector",
      results: [expect.objectContaining({ path: "wiki/vector.md" })],
    });
    expect(embedder.embed).toHaveBeenCalledTimes(1);
  });

  it("paginates hybrid results with opaque keyset cursor state", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nsemantic payload alpha");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nsemantic payload beta");
    await writeVaultFile(vaultRoot, "wiki/c.md", "# C\n\nsemantic payload gamma");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/a.md", profile, vector(0));
    await embedPath(indexDb, "wiki/b.md", profile, vector(1));
    await embedPath(indexDb, "wiki/c.md", profile, vector(2));
    upsertMeta(indexDb, "vectorGeneration", "7");
    const executor = new InlineSearchExecutor({
      indexDb,
      embedder: fakeEmbedder(vector(0)),
      profile,
      k: 3,
    });

    const first = await executor.search({ query: "semantic payload", limit: 1 });
    const second = await executor.search({ query: "semantic payload", limit: 1, cursor: first.nextCursor });

    expect(first.hybridMode).toBe("lexical-plus-vector");
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toBe("1");
    expect(second.cursorStatus).toBe("ok");
    expect(second.results).toHaveLength(1);
    expect(second.results[0]?.path).not.toBe(first.results[0]?.path);

    const payload = decodeCursor(first.nextCursor);
    expect(Object.keys(payload).sort()).toEqual([
      "embeddingProfileId",
      "fusionParams",
      "hybridMode",
      "lexicalGeneration",
      "limit",
      "position",
      "queryFingerprint",
      "tiebreakVersion",
      "vectorCoverageAtQuery",
      "vectorGeneration",
    ]);
    expect(payload).toMatchObject({
      embeddingProfileId: profile.profileId,
      hybridMode: "lexical-plus-vector",
      vectorCoverageAtQuery: { embeddedEligible: 3, totalEligible: 3 },
      vectorGeneration: "7",
      limit: 1,
      position: {
        relPath: first.results[0]?.path,
        rowid: expect.any(Number),
        fusedScore: expect.any(Number),
      },
    });
    expect(payload).not.toHaveProperty("offset");
  });

  it("refreshes instead of continuing when any carried cursor field is stale", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nsemantic payload alpha");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nsemantic payload beta");
    await writeVaultFile(vaultRoot, "wiki/c.md", "# C\n\nsemantic payload gamma");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/a.md", profile, vector(0));
    await embedPath(indexDb, "wiki/b.md", profile, vector(1));
    await embedPath(indexDb, "wiki/c.md", profile, vector(2));
    upsertMeta(indexDb, "vectorGeneration", "7");
    const executor = new InlineSearchExecutor({
      indexDb,
      embedder: fakeEmbedder(vector(0)),
      profile,
      k: 3,
    });
    const first = await executor.search({ query: "semantic payload", limit: 1 });
    const payload = decodeCursor(first.nextCursor);
    const mutations: Array<readonly [string, (payload: Record<string, unknown>) => Record<string, unknown>]> = [
      ["queryFingerprint", (cursor) => ({ ...cursor, queryFingerprint: "stale-fingerprint" })],
      ["lexicalGeneration", (cursor) => ({ ...cursor, lexicalGeneration: "stale-lexical-generation" })],
      ["vectorGeneration", (cursor) => ({ ...cursor, vectorGeneration: "stale-vector-generation" })],
      ["embeddingProfileId", (cursor) => ({ ...cursor, embeddingProfileId: "stale-profile" })],
      ["hybridMode", (cursor) => ({ ...cursor, hybridMode: "lexical-only" })],
      [
        "vectorCoverageAtQuery",
        (cursor) => ({ ...cursor, vectorCoverageAtQuery: { embeddedEligible: 0, totalEligible: 3 } }),
      ],
      [
        "fusionParams",
        (cursor) => ({
          ...cursor,
          fusionParams: { ...(cursor["fusionParams"] as Record<string, unknown>), oversample: 99 },
        }),
      ],
      ["tiebreakVersion", (cursor) => ({ ...cursor, tiebreakVersion: "stale-tiebreak" })],
      ["limit", (cursor) => ({ ...cursor, limit: 2 })],
    ];

    for (const [field, mutate] of mutations) {
      const response = await executor.search({
        query: "semantic payload",
        limit: 1,
        cursor: encodeCursor(mutate(payload)),
      });

      expect(response.cursorStatus, field).toBe("stale");
      expect(response.cursor, field).toBeNull();
      expect(response.results[0]?.path, field).toBe(first.results[0]?.path);
    }
  });

  it("refreshes stale cursors instead of continuing across lexical-only to hybrid transitions", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nneedle alpha");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nneedle beta");
    await reconcileIndex(indexDb, vaultRoot);
    const executor = new InlineSearchExecutor({
      indexDb,
      embedder: fakeEmbedder(vector(0)),
      profile,
      k: 2,
    });

    const lexicalOnly = await executor.search({ query: "needle", limit: 1 });
    await embedPath(indexDb, "wiki/a.md", profile, vector(0));
    await embedPath(indexDb, "wiki/b.md", profile, vector(1));
    upsertMeta(indexDb, "vectorGeneration", "1");
    const refreshed = await executor.search({ query: "needle", limit: 1, cursor: lexicalOnly.nextCursor });

    expect(lexicalOnly.hybridMode).toBe("lexical-only");
    expect(refreshed.hybridMode).toBe("lexical-plus-vector");
    expect(refreshed.cursorStatus).toBe("stale");
    expect(refreshed.cursor).toBeNull();
    expect(refreshed.warnings).toContain("cursor-stale: hybridMode changed");
    expect(refreshed.results[0]?.path).toBe(lexicalOnly.results[0]?.path);
  });

  it("refreshes stale cursors when the embedding profile changes", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    const nextProfile = profileFingerprint({ modelHash: "model-b" });
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nsemantic payload alpha");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nsemantic payload beta");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/a.md", profile, vector(0));
    await embedPath(indexDb, "wiki/b.md", profile, vector(1));
    const firstExecutor = new InlineSearchExecutor({
      indexDb,
      embedder: fakeEmbedder(vector(0)),
      profile,
      k: 2,
    });
    const nextExecutor = new InlineSearchExecutor({
      indexDb,
      embedder: fakeEmbedder(vector(0)),
      profile: nextProfile,
      k: 2,
    });

    const first = await firstExecutor.search({ query: "semantic", limit: 1 });
    const refreshed = await nextExecutor.search({ query: "semantic", limit: 1, cursor: first.nextCursor });

    expect(refreshed.cursorStatus).toBe("stale");
    expect(refreshed.cursor).toBeNull();
    expect(refreshed.warnings).toContain("cursor-stale: embeddingProfileId changed");
    expect(refreshed.results[0]?.path).toBe(first.results[0]?.path);
  });

  it("refreshes malformed cursors without treating them as offsets", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# A\n\nneedle alpha");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# B\n\nneedle beta");
    await reconcileIndex(indexDb, vaultRoot);
    const executor = new InlineSearchExecutor({ indexDb, embedder: null });

    const response = await executor.search({ query: "needle", limit: 1, cursor: "1" });

    expect(response.cursorStatus).toBe("invalid");
    expect(response.cursor).toBeNull();
    expect(response.warnings).toContain("cursor-invalid");
    expect(response.results[0]?.path).toBe("wiki/a.md");
  });

  it("keeps lexical-only search when vector coverage is not ready", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    const embedder = { embed: vi.fn(async () => [vector(0)]) } satisfies EmbedClient;
    await writeVaultFile(vaultRoot, "wiki/lexical.md", "# Lexical\n\nneedle stays available");
    await reconcileIndex(indexDb, vaultRoot);
    const executor = new InlineSearchExecutor({ indexDb, embedder, profile });

    const response = await executor.search({ query: "needle", limit: 1 });

    expect(response.hybridMode).toBe("lexical-only");
    expect(response.vectorState).toBe("backfilling");
    expect(response.vectorCoverage).toEqual({ embeddedEligible: 0, totalEligible: 1 });
    expect(response.results.map((result) => result.path)).toEqual(["wiki/lexical.md"]);
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it("degrades to lexical-only when the query embedder is unavailable", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/lexical.md", "# Lexical\n\nneedle stays available");
    await reconcileIndex(indexDb, vaultRoot);
    const executor = new InlineSearchExecutor({ indexDb, embedder: null });

    const response = await executor.search({ query: "needle", limit: 1 });

    expect(response.hybridMode).toBe("lexical-only");
    expect(response.vectorState).toBe("unavailable");
    expect(response.warnings).toContain("vector search unavailable: query embedder is not loaded");
    expect(response.results.map((result) => result.path)).toEqual(["wiki/lexical.md"]);
  });

  it("cancels a superseded in-flight vector request", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/vector.md", "# Vector\n\nsemantic payload");
    await reconcileIndex(indexDb, vaultRoot);
    await embedPath(indexDb, "wiki/vector.md", profile, vector(0));
    let calls = 0;
    const embedder = {
      embed: vi.fn(async (_texts, opts) => {
        calls += 1;
        if (calls === 1) {
          return await new Promise<readonly Float32Array[]>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        }
        return [vector(0)];
      }),
    } satisfies EmbedClient;
    const executor = new InlineSearchExecutor({
      indexDb,
      embedder,
      profile,
      k: 1,
      maxConcurrentVectorSearches: 2,
    });

    const first = executor.search({ query: "first", limit: 1 });
    await until(() => embedder.embed.mock.calls.length === 1);
    const second = executor.search({ query: "second", limit: 1 });

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({
      hybridMode: "lexical-plus-vector",
      results: [expect.objectContaining({ path: "wiki/vector.md" })],
    });
  });

  async function createHarness(): Promise<{ vaultRoot: string; indexDb: IndexDb }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-vector-search-"));
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

  async function embedPath(
    indexDb: IndexDb,
    relPath: string,
    profile: EmbeddingProfileFingerprint,
    nextVector: Float32Array,
  ): Promise<void> {
    await ingestChunkVector({
      database: indexDb.database,
      chunkRowid: onlyChunkRowid(indexDb, relPath),
      profile,
      embedder: fakeEmbedder(nextVector),
    });
  }

  function onlyChunkRowid(indexDb: IndexDb, relPath: string): number {
    return Number(
      indexDb.database.prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE relPath = ?").get(relPath)?.rowid,
    );
  }

  function upsertMeta(indexDb: IndexDb, key: string, value: string): void {
    indexDb.database
      .prepare<[string, string]>("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(key, value);
  }

  function decodeCursor(cursor: string | null): Record<string, unknown> {
    if (!cursor) throw new Error("expected cursor");
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  function encodeCursor(cursor: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
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

  function fakeEmbedder(next: Float32Array): EmbedClient {
    return {
      embed: async () => [next],
    };
  }

  function vector(index: number): Float32Array {
    const values = new Float32Array(384);
    values[index] = 1;
    return values;
  }

  function chunk(rowid: number, chunkId: string, relPath: string): ChunkRrfInput {
    return {
      rowid,
      chunkId,
      relPath,
      ordinal: 0,
      headingPath: null,
      byteStart: 0,
      byteEnd: 10,
      text: `${relPath} text`,
    };
  }

  function vectorResult(input: ChunkRrfInput): VectorSearchResult {
    return {
      ...input,
      distance: 0,
      vectorRank: 1,
    };
  }

  function abortError(): Error {
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not met");
  }
});
