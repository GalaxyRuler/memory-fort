import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import {
  createEmbeddingProfileFingerprint,
  ingestChunkVector,
  type EmbedClient,
  type EmbeddingProfileFingerprint,
} from "../../src/index/embed.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import { lexicalSearch } from "../../src/index/search.js";

describe("reconcileIndex", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("indexes markdown files under raw and wiki into files and chunks", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/capture.md", "# Capture\n\nalpha beta gamma");
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nwiki delta epsilon");

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result.filesIndexed).toBe(2);
    expect(result.filesTombstoned).toBe(0);
    expect(result.chunks).toBe(2);
    expect(selectFilePaths(indexDb)).toEqual(["raw/capture.md", "wiki/page.md"]);
    expect(selectChunks(indexDb)).toEqual([
      { relPath: "raw/capture.md", ordinal: 0, text: "# Capture\n\nalpha beta gamma" },
      { relPath: "wiki/page.md", ordinal: 0, text: "# Page\n\nwiki delta epsilon" },
    ]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("keeps capture spool records out of indexed documents and search results", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const previousSpoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    const spoolDir = join(tempDir!, "installation-state", "capture-spool");
    const eventId = "capture-spool-event-x7q9";
    const sentinel = "spoolonlysentinelx7q9";
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = spoolDir;

    try {
      await mkdir(spoolDir, { recursive: true });
      await writeFile(join(spoolDir, `${eventId}.json`), JSON.stringify({
        version: 1,
        id: eventId,
        hash: "spool-hash-x7q9",
        rawPath: join(vaultRoot, "raw", "capture.md"),
        block: `\n## Prompt\n\n${sentinel}\n`,
        createdAt: "2026-07-23T04:00:00.000Z",
      }), "utf-8");
      await writeVaultFile(vaultRoot, "wiki/live.md", "# Live\n\nindexed-live-token");

      await reconcileIndex(indexDb, vaultRoot);

      expect(selectFilePaths(indexDb)).toEqual(["wiki/live.md"]);
      const indexedText = selectChunks(indexDb).map((chunk) => chunk.text).join("\n");
      expect(indexedText).not.toContain(sentinel);
      expect(indexedText).not.toContain(eventId);
      expect(lexicalSearch(indexDb, sentinel)).toEqual([]);
      expect(lexicalSearch(indexDb, eventId)).toEqual([]);
      expect(lexicalSearch(indexDb, "indexed-live-token").map((hit) => hit.relPath)).toEqual([
        "wiki/live.md",
      ]);
    } finally {
      if (previousSpoolDir === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
      else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpoolDir;
    }
  });

  it("stores frontmatter status, lifecycle, confidence, validation, and dates on files", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/metadata.md",
      [
        "---",
        "title: Metadata Page",
        "type: projects",
        "status: superseded",
        "lifecycle: proposed",
        "confidence:",
        "  extraction: 0.42",
        "  validation: challenged",
        "created: 2026-06-01",
        "updated: 2026-07-01",
        "observed_at: 2026-06-15",
        "---",
        "",
        "# Metadata Page",
        "",
        "frontmatter metadata should be stored with the file row",
      ].join("\n"),
    );

    await reconcileIndex(indexDb, vaultRoot);

    expect(selectFileMetadata(indexDb, "wiki/projects/metadata.md")).toEqual({
      frontmatterStatus: "superseded",
      frontmatterLifecycle: "proposed",
      frontmatterConfidence: 0.42,
      frontmatterConfidenceJson: "{\"extraction\":0.42,\"validation\":\"challenged\"}",
      frontmatterValidation: "challenged",
      frontmatterCreated: "2026-06-01",
      frontmatterUpdated: "2026-07-01",
      frontmatterObservedAt: "2026-06-15",
    });
  });

  it("persists the derived crystal kind for a type-defined wiki document", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/typed-crystal.md",
      [
        "---",
        "title: Typed Crystal",
        "type: crystal",
        "---",
        "",
        "persisted crystal kind",
      ].join("\n"),
    );

    await reconcileIndex(indexDb, vaultRoot);

    expect(
      indexDb.database
        .prepare<[string], { kind: string }>("SELECT kind FROM files WHERE relPath = ?")
        .get("wiki/projects/typed-crystal.md"),
    ).toEqual({ kind: "crystal" });
  });

  it("skips dot-directory markdown backups under raw and wiki so they cannot be searched", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/capture.md", "# Capture\n\nrawliveonly");
    await writeVaultFile(vaultRoot, "raw/.history/capture.md", "# Raw Backup\n\nraw-backup-only-token");
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nwikiliveonly");
    await writeVaultFile(vaultRoot, "wiki/.history/wiki/page.md/2026-07-03T00-00-00-000Z.md", "# Wiki Backup\n\nwiki-backup-only-token");

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result.filesIndexed).toBe(2);
    expect(selectFilePaths(indexDb)).toEqual(["raw/capture.md", "wiki/page.md"]);
    expect(lexicalSearch(indexDb, "rawliveonly").map((hit) => hit.relPath)).toEqual(["raw/capture.md"]);
    expect(lexicalSearch(indexDb, "raw-backup-only-token")).toEqual([]);
    expect(lexicalSearch(indexDb, "wiki-backup-only-token")).toEqual([]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("skips an unchanged file on a rerun without rewriting its chunks", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nsame content");
    await reconcileIndex(indexDb, vaultRoot);
    const originalChunks = selectChunks(indexDb);

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result).toEqual({ filesIndexed: 0, filesTombstoned: 0, chunks: 0, filesSkipped: 0 });
    expect(selectChunks(indexDb)).toEqual(originalChunks);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("hash-confirms same-content files when metadata changes without rewriting chunks", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/capture.md", "# Capture\n\nsame content");
    await reconcileIndex(indexDb, vaultRoot);
    const originalChunks = selectChunks(indexDb);
    await utimes(vaultPath(vaultRoot, "raw/capture.md"), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result).toEqual({ filesIndexed: 0, filesTombstoned: 0, chunks: 0, filesSkipped: 0 });
    expect(selectChunks(indexDb)).toEqual(originalChunks);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("tombstones deleted files after a completed walk and leaves no FTS ghost rows", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nsurvives");
    await writeVaultFile(vaultRoot, "raw/deleted.md", "# Deleted\n\nghostterm");
    await reconcileIndex(indexDb, vaultRoot);
    await unlink(vaultPath(vaultRoot, "raw/deleted.md"));

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result).toEqual({ filesIndexed: 0, filesTombstoned: 1, chunks: 0, filesSkipped: 0 });
    expect(selectFilePaths(indexDb)).toEqual(["wiki/page.md"]);
    expect(countChunks(indexDb, "raw/deleted.md")).toBe(0);
    expect(searchChunkTexts(indexDb, "ghostterm")).toEqual([]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("reclaims vec0 rows when tombstoning a deleted file with vectors", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/vectorized.md", "# Vectorized\n\nsemantic payload");
    await reconcileIndex(indexDb, vaultRoot);
    await ingestChunkVector({
      database: indexDb.database,
      chunkRowid: onlyChunkRowid(indexDb, "wiki/vectorized.md"),
      profile: profileFingerprint(),
      embedder: fakeEmbedder(vector(0)),
    });
    expect(countRows(indexDb, "chunk_vectors")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);

    await unlink(vaultPath(vaultRoot, "wiki/vectorized.md"));
    await reconcileIndex(indexDb, vaultRoot);

    expect(countRows(indexDb, "chunk_vectors")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(0);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("does not collide with stale vec0 rows when SQLite recycles a chunk rowid", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    const profile = profileFingerprint();
    await writeVaultFile(vaultRoot, "wiki/old.md", "# Old\n\nold vectorized payload");
    await reconcileIndex(indexDb, vaultRoot);
    const oldRowid = onlyChunkRowid(indexDb, "wiki/old.md");
    await ingestChunkVector({
      database: indexDb.database,
      chunkRowid: oldRowid,
      profile,
      embedder: fakeEmbedder(vector(2)),
    });
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);

    await unlink(vaultPath(vaultRoot, "wiki/old.md"));
    await reconcileIndex(indexDb, vaultRoot);
    await writeVaultFile(vaultRoot, "wiki/new.md", "# New\n\nnew vectorized payload");
    await reconcileIndex(indexDb, vaultRoot);
    const recycledRowid = onlyChunkRowid(indexDb, "wiki/new.md");

    expect(recycledRowid).toBe(oldRowid);
    expect(countRows(indexDb, "chunk_vectors")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(0);
    await expect(
      ingestChunkVector({
        database: indexDb.database,
        chunkRowid: recycledRowid,
        profile,
        embedder: fakeEmbedder(vector(3)),
      }),
    ).resolves.toMatchObject({ status: "embedded", coarseRowid: recycledRowid });
    expect(selectVectorRows(indexDb)).toEqual([{ chunkRowid: recycledRowid, coarseRowid: recycledRowid }]);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(1);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(1);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("reclaims vec0 rows when replacing chunks for a changed file", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/changed.md", "# Changed\n\nold vectorized payload");
    await reconcileIndex(indexDb, vaultRoot);
    await ingestChunkVector({
      database: indexDb.database,
      chunkRowid: onlyChunkRowid(indexDb, "wiki/changed.md"),
      profile: profileFingerprint(),
      embedder: fakeEmbedder(vector(1)),
    });

    await writeVaultFile(vaultRoot, "wiki/changed.md", "# Changed\n\nnew lexical payload");
    await reconcileIndex(indexDb, vaultRoot);

    expect(countRows(indexDb, "chunk_vectors")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_bin")).toBe(0);
    expect(countRows(indexDb, "chunk_vectors_i8")).toBe(0);
    expect(searchChunkTexts(indexDb, "new")).toEqual(["# Changed\n\nnew lexical payload"]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("reindexes changed content and removes old FTS terms", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\noldterm");
    await reconcileIndex(indexDb, vaultRoot);
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nnewterm changed");

    const result = await reconcileIndex(indexDb, vaultRoot);

    expect(result).toEqual({ filesIndexed: 1, filesTombstoned: 0, chunks: 1, filesSkipped: 0 });
    expect(searchChunkTexts(indexDb, "oldterm")).toEqual([]);
    expect(searchChunkTexts(indexDb, "newterm")).toEqual(["# Page\n\nnewterm changed"]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("does not tombstone missing files when a run aborts mid-walk", async () => {
    const { vaultRoot, dbPath, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/keep.md", "# Keep\n\nkept");
    await writeVaultFile(vaultRoot, "wiki/deleted.md", "# Deleted\n\nghostterm");
    await reconcileIndex(indexDb, vaultRoot);
    await unlink(vaultPath(vaultRoot, "wiki/deleted.md"));
    await writeVaultFile(vaultRoot, "raw/new.md", "# New\n\nnewterm");

    await expect(
      reconcileIndex(indexDb, vaultRoot, {
        onEvent: (event) => {
          if (event.type === "fileDiscovered" && event.relPath === "raw/new.md") {
            throw new Error("simulated kill mid-walk");
          }
        },
      }),
    ).rejects.toThrow("simulated kill mid-walk");

    const reopened = reopenIndexDb(dbPath, indexDb);
    expect(selectFilePaths(reopened)).toEqual(["raw/keep.md", "wiki/deleted.md"]);
    expect(searchChunkTexts(reopened, "ghostterm")).toEqual(["# Deleted\n\nghostterm"]);
    expect(searchChunkTexts(reopened, "newterm")).toEqual([]);
    expect(() => reopened.integrityCheck()).not.toThrow();
  });

  it("rolls back a file transaction when a run aborts mid-file", async () => {
    const { vaultRoot, dbPath, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\noldterm");
    await reconcileIndex(indexDb, vaultRoot);
    const oldChunks = selectChunks(indexDb);
    await writeVaultFile(vaultRoot, "wiki/page.md", "# Page\n\nnewterm changed");

    await expect(
      reconcileIndex(indexDb, vaultRoot, {
        onEvent: (event) => {
          if (event.type === "fileChunksDeleted" && event.relPath === "wiki/page.md") {
            throw new Error("simulated kill mid-file");
          }
        },
      }),
    ).rejects.toThrow("simulated kill mid-file");

    const reopened = reopenIndexDb(dbPath, indexDb);
    expect(selectChunks(reopened)).toEqual(oldChunks);
    expect(searchChunkTexts(reopened, "oldterm")).toEqual(["# Page\n\noldterm"]);
    expect(searchChunkTexts(reopened, "newterm")).toEqual([]);
    expect(() => reopened.integrityCheck()).not.toThrow();
  });

  it("skips a newly oversized file and still tombstones missing files", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/deleted.md", "# Deleted\n\nghostterm");
    await reconcileIndex(indexDb, vaultRoot);
    await unlink(vaultPath(vaultRoot, "wiki/deleted.md"));
    await writeVaultFile(vaultRoot, "raw/too-large.md", "# Too Large\n\noversized");

    const result = await reconcileIndex(indexDb, vaultRoot, { maxFileBytes: 4 });

    expect(result).toEqual({ filesIndexed: 0, filesTombstoned: 1, chunks: 0, filesSkipped: 1 });
    expect(selectFilePaths(indexDb)).toEqual(["raw/too-large.md"]);
    expect(selectFileRows(indexDb)).toEqual([
      expect.objectContaining({
        relPath: "raw/too-large.md",
        errorState: "too-large",
        contentHash: null,
      }),
    ]);
    expect(searchChunkTexts(indexDb, "ghostterm")).toEqual([]);
    expect(searchChunkTexts(indexDb, "oversized")).toEqual([]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("skips an oversized file without aborting the reconcile run", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/too-large.md", "# Original\n\noldterm");
    await writeVaultFile(vaultRoot, "wiki/deleted.md", "# Deleted\n\nghostterm");
    await reconcileIndex(indexDb, vaultRoot);
    await unlink(vaultPath(vaultRoot, "wiki/deleted.md"));
    await writeVaultFile(vaultRoot, "raw/too-large.md", `# Too Large\n\n${"oversized ".repeat(20)}`);
    await writeVaultFile(vaultRoot, "wiki/rest.md", "# Rest\n\nneedle survives");

    const result = await reconcileIndex(indexDb, vaultRoot, { maxFileBytes: 64 });

    expect(result).toEqual({ filesIndexed: 1, filesTombstoned: 1, chunks: 1, filesSkipped: 1 });
    expect(selectFilePaths(indexDb)).toEqual(["raw/too-large.md", "wiki/rest.md"]);
    expect(selectFileRows(indexDb)).toEqual([
      expect.objectContaining({
        relPath: "raw/too-large.md",
        errorState: "too-large",
        contentHash: null,
      }),
      expect.objectContaining({
        relPath: "wiki/rest.md",
        errorState: null,
      }),
    ]);
    expect(countChunks(indexDb, "raw/too-large.md")).toBe(0);
    expect(searchChunkTexts(indexDb, "oldterm")).toEqual([]);
    expect(searchChunkTexts(indexDb, "oversized")).toEqual([]);
    expect(searchChunkTexts(indexDb, "needle")).toEqual(["# Rest\n\nneedle survives"]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  it("skips a file when chunk rows exceed the cap", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "raw/many-chunks.md", "# Many\n\none two three four five six seven eight");

    const result = await reconcileIndex(indexDb, vaultRoot, {
      maxChunksPerFile: 1,
      chunkOptions: { maxTokens: 2, overlapTokens: 0, maxChunkChars: 40 },
    });

    expect(result).toEqual({ filesIndexed: 0, filesTombstoned: 0, chunks: 0, filesSkipped: 1 });
    expect(selectFileRows(indexDb)).toEqual([
      expect.objectContaining({
        relPath: "raw/many-chunks.md",
        errorState: "too-many-chunks",
        contentHash: null,
      }),
    ]);
    expect(countChunks(indexDb, "raw/many-chunks.md")).toBe(0);
    expect(searchChunkTexts(indexDb, "seven")).toEqual([]);
    expect(() => indexDb.integrityCheck()).not.toThrow();
  });

  async function createHarness(): Promise<{ vaultRoot: string; dbPath: string; indexDb: IndexDb }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-reconcile-"));
    const vaultRoot = join(tempDir, "vault");
    await mkdir(vaultRoot, { recursive: true });
    const dbPath = join(tempDir, "index.db");
    const indexDb = openIndexDb(dbPath);
    openDbs.push(indexDb);
    return { vaultRoot, dbPath, indexDb };
  }

  function reopenIndexDb(dbPath: string, previous: IndexDb): IndexDb {
    const index = openDbs.indexOf(previous);
    if (index >= 0) openDbs.splice(index, 1);
    previous.close();
    const next = openIndexDb(dbPath);
    openDbs.push(next);
    return next;
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = vaultPath(vaultRoot, relPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  function vaultPath(vaultRoot: string, relPath: string): string {
    return join(vaultRoot, ...relPath.split("/"));
  }

  function selectFilePaths(indexDb: IndexDb): string[] {
    return (
      indexDb.database.prepare<[], { relPath: string }>("SELECT relPath FROM files ORDER BY relPath").all()
    ).map((row) => row.relPath);
  }

  function selectFileRows(indexDb: IndexDb): Array<{ relPath: string; errorState: string | null; contentHash: string | null }> {
    return indexDb.database
      .prepare<[], { relPath: string; errorState: string | null; contentHash: string | null }>(
        "SELECT relPath, errorState, contentHash FROM files ORDER BY relPath",
      )
      .all();
  }

  function selectFileMetadata(indexDb: IndexDb, relPath: string): {
    frontmatterStatus: string | null;
    frontmatterLifecycle: string | null;
    frontmatterConfidence: number | null;
    frontmatterConfidenceJson: string | null;
    frontmatterValidation: string | null;
    frontmatterCreated: string | null;
    frontmatterUpdated: string | null;
    frontmatterObservedAt: string | null;
  } | undefined {
    return indexDb.database
      .prepare<[string], ReturnType<typeof selectFileMetadata>>(
        `SELECT
           frontmatterStatus,
           frontmatterLifecycle,
           frontmatterConfidence,
           frontmatterConfidenceJson,
           frontmatterValidation,
           frontmatterCreated,
           frontmatterUpdated,
           frontmatterObservedAt
         FROM files
         WHERE relPath = ?`,
      )
      .get(relPath);
  }

  function selectChunks(indexDb: IndexDb): Array<{ relPath: string; ordinal: number; text: string }> {
    return indexDb.database
      .prepare<[], { relPath: string; ordinal: number; text: string }>(
        "SELECT relPath, ordinal, text FROM chunks ORDER BY relPath, ordinal",
      )
      .all();
  }

  function countChunks(indexDb: IndexDb, relPath: string): number {
    return (
      indexDb.database.prepare<[string], { count: number }>("SELECT count(*) AS count FROM chunks WHERE relPath = ?").get(
        relPath,
      )?.count ?? 0
    );
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

  function onlyChunkRowid(indexDb: IndexDb, relPath: string): number {
    return Number(
      indexDb.database.prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE relPath = ?").get(relPath)?.rowid,
    );
  }

  function countRows(indexDb: IndexDb, table: "chunk_vectors" | "chunk_vectors_bin" | "chunk_vectors_i8"): number {
    return (indexDb.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  }

  function selectVectorRows(indexDb: IndexDb): Array<{ chunkRowid: number; coarseRowid: number }> {
    return indexDb.database
      .prepare<[], { chunkRowid: number; coarseRowid: number }>(
        "SELECT chunkRowid, coarseRowid FROM chunk_vectors ORDER BY chunkRowid",
      )
      .all();
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
});
