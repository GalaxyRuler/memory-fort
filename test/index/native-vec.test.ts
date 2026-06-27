import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityError,
  type CapabilityDb,
  assertVec0Knn,
  closeCapabilityDb,
  loadSqliteVec,
  openCapabilityDb,
  resolveSqliteVecBinary,
} from "../../src/index/native/capability.js";

// Dev feedback only: this runs under system Node, not Electron's Node ABI.
// The Electron runtime gate in smoke.yml is the sqlite-vec + better-sqlite3 gate.
describe("native sqlite-vec capability", () => {
  const dbs: CapabilityDb[] = [];

  afterEach(() => {
    while (dbs.length > 0) {
      const db = dbs.pop();
      if (db) closeCapabilityDb(db);
    }
  });

  it("resolves the platform sqlite-vec loadable extension", () => {
    const binaryPath = resolveSqliteVecBinary();

    expect(isAbsolute(binaryPath)).toBe(true);
    expect(existsSync(binaryPath)).toBe(true);
    expect(basename(binaryPath)).toMatch(/^vec0\.(dll|dylib|so)$/);
  });

  it("loads sqlite-vec and verifies exact vec0 KNN", () => {
    const db = track(openCapabilityDb(":memory:"));

    loadSqliteVec(db);

    expect(() => assertVec0Knn(db)).not.toThrow();
  });

  it("wraps sqlite-vec load failures in CapabilityError", () => {
    const fakeDb = {
      path: ":memory:",
      database: {
        exec: () => undefined,
        loadExtension: () => {
          throw new Error("load failed");
        },
        pragma: () => undefined,
        prepare: () => {
          throw new Error("unused");
        },
        close: () => undefined,
      },
    } as CapabilityDb;

    let thrown: unknown;
    try {
      loadSqliteVec(fakeDb);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).step).toBe("vec-load");
    expect((thrown as CapabilityError).message).toContain("Failed to load sqlite-vec extension");
  });

  function track(db: CapabilityDb): CapabilityDb {
    dbs.push(db);
    return db;
  }
});
