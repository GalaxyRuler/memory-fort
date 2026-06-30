import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import { reconcileIndex } from "../../src/index/reconcile.js";

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
});
