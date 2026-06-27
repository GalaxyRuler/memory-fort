import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityError,
  type CapabilityDb,
  assertFts5,
  closeCapabilityDb,
  openCapabilityDb,
} from "../../src/index/native/capability.js";

// Dev feedback only: this runs under system Node, not Electron's Node ABI.
// The Electron runtime gate in smoke.yml is the native-addon ABI gate.
describe("native FTS5 capability", () => {
  const dbs: CapabilityDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (dbs.length > 0) {
      const db = dbs.pop();
      if (db) closeCapabilityDb(db);
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("opens an in-memory better-sqlite3 database and verifies FTS5 bm25 ordering", () => {
    const db = track(openCapabilityDb(":memory:"));

    expect(() => assertFts5(db)).not.toThrow();
  });

  it("enables WAL for file-backed capability databases", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-capability-"));
    const db = track(openCapabilityDb(join(tempDir, "capability.sqlite")));

    expect(String(db.database.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
  });

  it("wraps malformed FTS5 queries in CapabilityError", () => {
    const db = track(openCapabilityDb(":memory:"));

    let thrown: unknown;
    try {
      assertFts5(db, { matchQuery: "\"unterminated" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).step).toBe("fts5-query");
    expect((thrown as CapabilityError).message).toContain("FTS5 MATCH query failed");
  });

  function track(db: CapabilityDb): CapabilityDb {
    dbs.push(db);
    return db;
  }
});
