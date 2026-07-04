import { fork as forkChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startSearchProcess, type SearchProcessParentPort } from "../../src/dashboard/search-process.js";
import {
  UtilityProcessSearchExecutor,
  type SearchProcessChild,
} from "../../src/dashboard/utility-search-executor.js";
import { openIndexDb, openReadOnlyIndexDb, type IndexDb } from "../../src/index/db.js";
import {
  createEmbeddingProfileFingerprint,
  ingestChunkVector,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
  type LocalBgeSmallEmbedClient,
} from "../../src/index/embed.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import { InlineSearchExecutor, type IndexSearchExecutorResponse } from "../../src/index/vector-search.js";

describe("UtilityProcessSearchExecutor", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("returns results equivalent to InlineSearchExecutor on the same vector fixture", async () => {
    const { vaultRoot, indexDbPath, profile } = await createReadyVectorFixture();
    const client = vectorClient(profile, vector(0));
    const readDb = openReadOnlyIndexDb(indexDbPath);
    openDbs.push(readDb);
    const inline = new InlineSearchExecutor({ indexDb: readDb, embedder: client, profile, k: 1 });
    const utility = new UtilityProcessSearchExecutor({
      vaultRoot,
      indexDbPath,
      searchProcessPath: __filename,
      fork: () => new LoopbackSearchChild(client),
    });

    const inlineResponse = await inline.search({ query: "semantic", limit: 1 });
    const utilityResponse = await utility.search({ query: "semantic", limit: 1 });

    expect(utilityResponse.hybridMode).toBe(inlineResponse.hybridMode);
    expect(utilityResponse.vectorState).toBe(inlineResponse.vectorState);
    expect(utilityResponse.results.map((result) => result.path)).toEqual(
      inlineResponse.results.map((result) => result.path),
    );
    utility.close();
  });

  it("re-reads the active embedding profile between search process requests", async () => {
    const { vaultRoot, indexDbPath, profile } = await createReadyVectorFixture([
      ["wiki/a.md", "# A\n\nsemantic payload alpha"],
      ["wiki/b.md", "# B\n\nsemantic payload beta"],
    ]);
    const nextProfile = profileFingerprint({ modelHash: "model-b" });
    const utility = new UtilityProcessSearchExecutor({
      vaultRoot,
      indexDbPath,
      searchProcessPath: __filename,
      fork: () => new LoopbackSearchChild(vectorClient(profile, vector(0))),
    });

    try {
      const first = await utility.search({ query: "semantic payload", limit: 1 });
      const writeDb = openIndexDb(indexDbPath);
      openDbs.push(writeDb);
      activateProfileMetadataOnly(writeDb, nextProfile);
      writeDb.close();
      openDbs.pop();
      const refreshed = await utility.search({ query: "semantic payload", limit: 1, cursor: first.nextCursor });

      expect(first.hybridMode).toBe("lexical-plus-vector");
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(refreshed.cursorStatus).toBe("stale");
      expect(refreshed.cursor).toBeNull();
      expect(refreshed.warnings).toContain("cursor-stale: embeddingProfileId changed");
    } finally {
      utility.close();
    }
  });

  it("keeps the caller event loop responsive while a real child-process search is pending", async () => {
    const childPath = await writeBlockingSearchChild();
    let searchPosted!: () => void;
    const searchPostedPromise = new Promise<void>((resolve) => {
      searchPosted = resolve;
    });
    const executor = new UtilityProcessSearchExecutor({
      vaultRoot: "C:/vault",
      searchProcessPath: childPath,
      fork: (entryPath) => forkRealSearchChild(entryPath, searchPosted),
    });

    const pending = executor.search({ query: "needle", limit: 1 });
    await searchPostedPromise;
    let timerFired = false;
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFired = true;
        resolve();
      }, 0);
    });

    expect(timerFired).toBe(true);
    await expect(pending).resolves.toMatchObject({ query: "needle" });
    executor.close();
  });

  it("rejects a killed search process request and restarts cleanly on the next search", async () => {
    let forks = 0;
    const executor = new UtilityProcessSearchExecutor({
      vaultRoot: "C:/vault",
      searchProcessPath: __filename,
      fork: () => {
        forks += 1;
        return forks === 1 ? new CrashOnSearchChild() : new DelayedSearchChild(0);
      },
    });

    await expect(executor.search({ query: "first", limit: 1 })).rejects.toThrow("search process exited");
    await expect(executor.search({ query: "second", limit: 1 })).resolves.toMatchObject({ query: "second" });
    expect(forks).toBe(2);
    executor.close();
  });

  async function createReadyVectorFixture(
    pages: Array<readonly [relPath: string, content: string]> = [["wiki/vector.md", "# Vector\n\nsemantic payload"]],
  ): Promise<{
    vaultRoot: string;
    indexDbPath: string;
    profile: EmbeddingProfileFingerprint;
  }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-utility-search-"));
    const vaultRoot = join(tempDir, "vault");
    const indexDbPath = join(tempDir, "index.db");
    await mkdir(vaultRoot, { recursive: true });
    for (const [relPath, content] of pages) {
      await writeVaultFile(vaultRoot, relPath, content);
    }
    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    const profile = profileFingerprint();
    await reconcileIndex(indexDb, vaultRoot);
    for (const [index, [relPath]] of pages.entries()) {
      await ingestChunkVector({
        database: indexDb.database,
        chunkRowid: onlyChunkRowid(indexDb, relPath),
        profile,
        embedder: fakeEmbedder(vector(index)),
      });
    }
    indexDb.close();
    openDbs.pop();
    return { vaultRoot, indexDbPath, profile };
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = join(vaultRoot, ...relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  function onlyChunkRowid(indexDb: IndexDb, relPath: string): number {
    return Number(
      indexDb.database.prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE relPath = ?").get(relPath)?.rowid,
    );
  }

  function activateProfileMetadataOnly(indexDb: IndexDb, profile: EmbeddingProfileFingerprint): void {
    indexDb.database
      .prepare(
        `INSERT INTO embedding_profiles(
          profileId, provider, runtime, runtimeVersion, modelId, modelRevision,
          modelHash, tokenizerHash, pooling, normalization, dtype, dimension,
          prefixStrategy, chunkerVersion, payloadRecipe, maxTokenPolicy, fingerprintJson, createdAt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        "{}",
        Date.now(),
      );
    indexDb.database
      .prepare<[string, string]>("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run("activeEmbeddingProfileId", profile.profileId);
  }

  async function writeBlockingSearchChild(): Promise<string> {
    tempDir ??= await mkdtemp(join(tmpdir(), "memory-utility-search-"));
    const childPath = join(tempDir, "blocking-search-child.mjs");
    await writeFile(
      childPath,
      `
function responseFor(query) {
  return {
    query,
    results: [],
    warnings: [],
    timings: {
      corpusMs: 0,
      refreshMs: 0,
      embedQueryMs: 0,
      bm25Ms: 0,
      vectorMs: 0,
      exactMs: 0,
      graphMs: 0,
      graphSpreadMs: 0,
      metadataMs: 0,
      rrfMs: 0,
      rerankMs: 0,
      totalMs: 0,
      intentClassification: {
        label: "open-ended",
        confidence: 0.5,
        method: "fallback",
        latencyMs: 0,
      },
    },
    degraded: false,
    hyde: { used: false, reason: "disabled-by-flag" },
    corpusErrorCount: 0,
    bm25Cache: {
      indexCacheHit: true,
      documentCount: 0,
      tokenCacheHits: 0,
      tokenCacheMisses: 0,
    },
    vectorState: "ready",
    vectorCoverage: { embeddedEligible: 0, totalEligible: 0 },
    hybridMode: "lexical-plus-vector",
    cursor: null,
    nextCursor: null,
  };
}

process.on("message", (message) => {
  if (message?.type === "init") {
    process.send?.({ type: "search-process-ready" });
    return;
  }
  if (message?.type === "search-request") {
    const deadline = Date.now() + 100;
    while (Date.now() < deadline) {}
    process.send?.({ type: "search-response", id: message.id, response: responseFor(message.request.query) });
    return;
  }
  if (message?.type === "shutdown") process.exit(0);
});
`,
      "utf8",
    );
    return childPath;
  }
});

class LoopbackSearchChild extends EventEmitter implements SearchProcessChild {
  private readonly childInbound = new EventEmitter();
  readonly pid = 10_001;

  constructor(client: LocalBgeSmallEmbedClient) {
    super();
    const parentPort: SearchProcessParentPort = {
      postMessage: (message) => queueMicrotask(() => this.emit("message", message)),
      on: (event, listener) => this.childInbound.on(event, listener),
    };
    void startSearchProcess({
      parentPort,
      createVectorEmbedClientImpl: async () => client,
      exit: (code) => this.emit("exit", code, null),
    });
  }

  postMessage(message: unknown): void {
    queueMicrotask(() => this.childInbound.emit("message", message));
  }

  kill(): void {
    this.emit("exit", null, "SIGTERM");
  }
}

class DelayedSearchChild extends EventEmitter implements SearchProcessChild {
  readonly pid = 10_002;

  constructor(private readonly delayMs: number) {
    super();
  }

  postMessage(message: unknown): void {
    if (isInitMessage(message)) {
      queueMicrotask(() => this.emit("message", { type: "search-process-ready" }));
      return;
    }
    if (isSearchRequest(message)) {
      setTimeout(() => {
        this.emit("message", {
          type: "search-response",
          id: message.id,
          response: responseFor(message.request.query),
        });
      }, this.delayMs);
    }
  }

  kill(): void {
    this.emit("exit", null, "SIGTERM");
  }
}

class CrashOnSearchChild extends EventEmitter implements SearchProcessChild {
  readonly pid = 10_003;

  postMessage(message: unknown): void {
    if (isInitMessage(message)) {
      queueMicrotask(() => this.emit("message", { type: "search-process-ready" }));
      return;
    }
    if (isSearchRequest(message)) {
      queueMicrotask(() => this.emit("exit", 1, null));
    }
  }

  kill(): void {
    this.emit("exit", null, "SIGTERM");
  }
}

function forkRealSearchChild(entryPath: string, onSearchRequest: () => void): SearchProcessChild {
  const child = forkChildProcess(entryPath, [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return {
    pid: child.pid,
    postMessage: (message) => {
      if (isSearchRequest(message)) onSearchRequest();
      child.send(message);
    },
    on: (event, listener) => child.on(event, listener as (...args: unknown[]) => void),
    off: (event, listener) => child.off(event, listener as (...args: unknown[]) => void),
    removeListener: (event, listener) => child.removeListener(event, listener as (...args: unknown[]) => void),
    once: (event, listener) => child.once(event, listener as (...args: unknown[]) => void),
    kill: () => {
      child.kill();
    },
  };
}

function responseFor(query: string): IndexSearchExecutorResponse {
  return {
    query,
    results: [],
    warnings: [],
    timings: {
      corpusMs: 0,
      refreshMs: 0,
      embedQueryMs: 0,
      bm25Ms: 0,
      vectorMs: 0,
      exactMs: 0,
      graphMs: 0,
      graphSpreadMs: 0,
      metadataMs: 0,
      rrfMs: 0,
      rerankMs: 0,
      totalMs: 0,
      intentClassification: {
        label: "open-ended",
        confidence: 0.5,
        method: "fallback",
        latencyMs: 0,
      },
    },
    degraded: false,
    hyde: { used: false, reason: "disabled-by-flag" },
    corpusErrorCount: 0,
    bm25Cache: {
      indexCacheHit: true,
      documentCount: 0,
      tokenCacheHits: 0,
      tokenCacheMisses: 0,
    },
    vectorState: "ready",
    vectorCoverage: { embeddedEligible: 0, totalEligible: 0 },
    hybridMode: "lexical-plus-vector",
    cursor: null,
    nextCursor: null,
  };
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

function vectorClient(profile: EmbeddingProfileFingerprint, next: Float32Array): LocalBgeSmallEmbedClient {
  return {
    profile,
    modelRoot: "test",
    loadTimeMs: 0,
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    embed: vi.fn(async () => [next]),
  };
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

function isInitMessage(message: unknown): message is { type: "init" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "init";
}

function isSearchRequest(message: unknown): message is { type: "search-request"; id: string; request: { query: string } } {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "search-request" &&
    typeof (message as { id?: unknown }).id === "string"
  );
}
