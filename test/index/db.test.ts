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

  it("keeps chunks_fts consistent across insert/update/delete (no ghost rows)", async () => {
    const { openIndexDb } = await import("../../src/index/db.js");
    tempDir = await mkdtemp(join(tmpdir(), "memory-index-db-"));
    const indexDb = track(openIndexDb(join(tempDir, "index.db")));
    const db = indexDb.database;

    db.prepare("INSERT INTO files(relPath, generation) VALUES('a.md', 1)").run();
    const insChunk = db.prepare(
      "INSERT INTO chunks(chunkId, relPath, ordinal, byteStart, byteEnd, text, textHash, generation) VALUES(?,?,?,?,?,?,?,?)",
    );
    insChunk.run("c1", "a.md", 0, 0, 5, "kafka streams", "h1", 1);
    insChunk.run("c2", "a.md", 1, 6, 11, "postgres rows", "h2", 1);

    const match = (term: string): string[] =>
      (
        db
          .prepare(
            "SELECT c.chunkId AS chunkId FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)",
          )
          .all(term) as Array<{ chunkId: string }>
      ).map((r) => r.chunkId);

    // insert trigger: terms are searchable
    expect(match("kafka")).toEqual(["c1"]);
    expect(match("postgres")).toEqual(["c2"]);

    // update trigger: old term gone (no ghost), new term present
    db.prepare("UPDATE chunks SET text = 'redis cache' WHERE chunkId = 'c1'").run();
    expect(match("kafka")).toEqual([]);
    expect(match("redis")).toEqual(["c1"]);

    // delete trigger: FTS entry removed
    db.prepare("DELETE FROM chunks WHERE chunkId = 'c2'").run();
    expect(match("postgres")).toEqual([]);

    // external-content index stays consistent with the content table
    expect(() => indexDb.integrityCheck()).not.toThrow();
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
