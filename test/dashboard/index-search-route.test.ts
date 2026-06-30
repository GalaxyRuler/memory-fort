import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/retrieval/corpus.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/retrieval/corpus.js")>(
    "../../src/retrieval/corpus.js",
  );
  return {
    ...actual,
    loadSearchCorpus: vi.fn(async () => {
      throw new Error("legacy loadSearchCorpus should not run in index mode");
    }),
  };
});

import { createServer, type RunningServer } from "../../src/dashboard/server.js";
import { startIndexWriter } from "../../src/dashboard/index-writer.js";
import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";

class FakeParentPort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

describe("dashboard index search route", () => {
  let tempDir: string | null = null;
  let server: RunningServer | null = null;
  const openDbs: IndexDb[] = [];

  afterEach(async () => {
    await server?.close();
    server = null;
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
    vi.clearAllMocks();
  });

  it("uses lexical index search when MEMORY_INDEX_SEARCH is enabled without loading the legacy corpus", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        ...process.env,
        MEMORY_INDEX_SEARCH: "1",
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.query).toBe("needle");
    expect(body.results).toEqual([
      expect.objectContaining({
        path: "wiki/indexed.md",
        source: "index",
        snippet: expect.stringContaining("needle"),
      }),
    ]);
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("uses the legacy search path when MEMORY_INDEX_SEARCH is not enabled", async () => {
    const { vaultRoot } = await createVault();
    vi.mocked(loadSearchCorpus).mockResolvedValue({
      documents: [legacyDocument(vaultRoot)],
      errors: [],
      rawTruncated: false,
      scannedCounts: { wiki: 1, raw: 0, crystals: 0 },
    });

    server = await createServer({
      vaultRoot,
      port: 0,
      env: { ...process.env, MEMORY_INDEX_SEARCH: "0" },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=legacy&noHyde=true`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0]?.path).toBe("wiki/legacy.md");
    expect(loadSearchCorpus).toHaveBeenCalledTimes(1);
  });

  it("serves index search through the read connection while the writer owns an active WAL transaction", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVault();
    const parentPort = new FakeParentPort();
    let releaseWriter!: () => void;
    let writerStarted!: () => void;
    const writerStartedPromise = new Promise<void>((resolve) => {
      writerStarted = resolve;
    });
    const exitCodes: number[] = [];

    const writerReady = startIndexWriter({
      parentPort,
      reconcileIndexImpl: async (indexDb) => {
        indexDb.database.exec("BEGIN IMMEDIATE");
        writerStarted();
        await new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        indexDb.database.exec("COMMIT");
        return { filesIndexed: 0, filesTombstoned: 0, chunks: 0 };
      },
      exit: (code) => {
        exitCodes.push(code);
      },
    });
    parentPort.emit("message", {
      vaultRoot,
      indexDbPath,
      debounceMs: 0,
      intervalMs: 0,
    });
    await writerReady;
    await writerStartedPromise;

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        ...process.env,
        MEMORY_INDEX_SEARCH: "1",
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const response = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const body = await response.json();
    releaseWriter();
    parentPort.emit("message", { type: "shutdown" });
    await until(() => exitCodes.length > 0);

    expect(response.status).toBe(200);
    expect(body.results[0]?.path).toBe("wiki/indexed.md");
    expect(exitCodes).toEqual([0]);
  });

  it("returns non-blocking indexing status when index search is enabled before the writer creates the DB", async () => {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir!, "missing", "index.db");

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        ...process.env,
        MEMORY_INDEX_SEARCH: "1",
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const search = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=5`);
    const searchBody = await search.json();
    const status = await fetch(`http://${server.host}:${server.port}/api/index-status`);
    const statusBody = await status.json();

    expect(search.status).toBe(200);
    expect(searchBody).toMatchObject({
      query: "needle",
      results: [],
      warnings: ["indexing"],
      degraded: true,
      index: {
        dbPath: indexDbPath,
        currentState: "building",
        ready: false,
      },
    });
    expect(status.status).toBe(200);
    expect(statusBody).toMatchObject({
      enabled: true,
      dbPath: indexDbPath,
      currentState: "building",
      ready: false,
    });
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("cursor-paginates index search results without loading the legacy corpus", async () => {
    const { vaultRoot, indexDbPath } = await createIndexedVaultWithPages([
      ["wiki/a.md", "# A\n\nneedle alpha"],
      ["wiki/b.md", "# B\n\nneedle beta"],
    ]);

    server = await createServer({
      vaultRoot,
      port: 0,
      env: {
        ...process.env,
        MEMORY_INDEX_SEARCH: "1",
        MEMORY_INDEX_DB_PATH: indexDbPath,
      },
      voyageClient: null,
    });

    const first = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=1`);
    const firstBody = await first.json();
    const second = await fetch(`http://${server.host}:${server.port}/api/search?q=needle&limit=1&cursor=${firstBody.nextCursor}`);
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(firstBody.results).toHaveLength(1);
    expect(firstBody.results[0].path).toBe("wiki/a.md");
    expect(firstBody.nextCursor).toBe("1");
    expect(second.status).toBe(200);
    expect(secondBody.results).toHaveLength(1);
    expect(secondBody.results[0].path).toBe("wiki/b.md");
    expect(secondBody.nextCursor).toBeNull();
    expect(loadSearchCorpus).not.toHaveBeenCalled();
  });

  it("runs a deliberate TRUNCATE checkpoint after each writer reconcile", async () => {
    const parentPort = new FakeParentPort();
    const pragmas: string[] = [];
    const fakeDb = {
      path: "C:/tmp/index.db",
      database: {
        exec: vi.fn(),
        pragma: vi.fn((sql: string) => {
          pragmas.push(sql);
          return [];
        }),
        prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn() })),
        close: vi.fn(),
      },
      close: vi.fn(),
      integrityCheck: vi.fn(),
      rebuildFts: vi.fn(),
    } as unknown as IndexDb;

    const ready = startIndexWriter({
      parentPort,
      openIndexDbImpl: () => fakeDb,
      reconcileIndexImpl: async () => ({ filesIndexed: 1, filesTombstoned: 0, chunks: 1 }),
      exit: () => undefined,
    });
    parentPort.emit("message", {
      vaultRoot: "C:/vault",
      debounceMs: 0,
      intervalMs: 0,
    });
    await ready;
    await until(() => pragmas.includes("wal_checkpoint(TRUNCATE)"));

    expect(pragmas).toContain("wal_checkpoint(TRUNCATE)");
  });

  async function createIndexedVault(): Promise<{ vaultRoot: string; indexDbPath: string }> {
    return createIndexedVaultWithPages([["wiki/indexed.md", "# Indexed\n\nneedle needle precise match"]]);
  }

  async function createIndexedVaultWithPages(
    pages: Array<readonly [relPath: string, content: string]>,
  ): Promise<{ vaultRoot: string; indexDbPath: string }> {
    const { vaultRoot } = await createVault();
    const indexDbPath = join(tempDir, "index", "index.db");
    for (const [relPath, content] of pages) {
      await writeVaultFile(vaultRoot, relPath, content);
    }

    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    await reconcileIndex(indexDb, vaultRoot);
    indexDb.close();
    openDbs.pop();

    return { vaultRoot, indexDbPath };
  }

  async function createVault(): Promise<{ vaultRoot: string }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-dashboard-index-search-"));
    const vaultRoot = join(tempDir, "vault");
    await mkdir(vaultRoot, { recursive: true });
    return { vaultRoot };
  }

  function legacyDocument(vaultRoot: string) {
    return {
      kind: "wiki" as const,
      relPath: "wiki/legacy.md",
      fullPath: join(vaultRoot, "wiki", "legacy.md"),
      title: "Legacy",
      type: "note",
      status: "active",
      cognitiveType: "semantic" as const,
      confidence: null,
      tags: [],
      relations: {},
      source: "test",
      session: null,
      importedFrom: null,
      body: "legacy search body",
      snippetSource: "legacy search body",
      created: null,
      observedAt: null,
      updated: null,
      mtime: new Date().toISOString(),
      sizeBytes: 18,
    };
  }

  async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("condition was not met");
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = join(vaultRoot, ...relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
});
