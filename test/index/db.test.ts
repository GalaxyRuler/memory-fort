import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("openIndexDb", () => {
  const openDbs: Array<{ close(): void }> = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      const db = openDbs.pop();
      if (db) db.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("opens a WAL database with the v1 schema and FTS triggers", async () => {
    const { openIndexDb } = await import("../../src/index/db.js");
    tempDir = await mkdtemp(join(tmpdir(), "memory-index-db-"));

    const indexDb = track(openIndexDb(join(tempDir, "index.db")));

    expect(String(indexDb.database.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    expect(indexDb.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({
      value: "1",
    });
    expect(indexDb.database.prepare("SELECT value FROM meta WHERE key = 'tokenizer'").get()).toEqual({
      value: "unicode61 remove_diacritics 2",
    });

    const tableRows = indexDb.database
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table') ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tableRows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["chunks", "chunks_fts", "files", "meta"]),
    );

    const triggerRows = indexDb.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(triggerRows.map((row) => row.name)).toEqual(["chunks_ad", "chunks_ai", "chunks_au"]);
  });

  it("drops a corrupted derived database and stale sidecars before rebuilding", async () => {
    const { openIndexDb } = await import("../../src/index/db.js");
    tempDir = await mkdtemp(join(tmpdir(), "memory-index-db-"));
    const dbPath = join(tempDir, "index.db");
    await writeFile(dbPath, "not a sqlite database");
    await writeFile(`${dbPath}-wal`, "stale wal sidecar");
    await writeFile(`${dbPath}-shm`, "stale shm sidecar");

    const indexDb = track(openIndexDb(dbPath));

    expect(indexDb.database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get()).toEqual({
      value: "1",
    });
    expect(() => indexDb.integrityCheck()).not.toThrow();
    expect(await readFile(dbPath, "utf8")).not.toBe("not a sqlite database");
    await expect(readFile(`${dbPath}-wal`, "utf8")).resolves.not.toBe("stale wal sidecar");
    await expect(readFile(`${dbPath}-shm`, "utf8")).resolves.not.toBe("stale shm sidecar");
  });

  function track<T extends { close(): void }>(db: T): T {
    openDbs.push(db);
    return db;
  }
});
