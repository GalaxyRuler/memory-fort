import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import { reconcileIndex } from "../../src/index/reconcile.js";
import { lexicalSearch } from "../../src/index/search.js";

describe("lexicalSearch", () => {
  const openDbs: IndexDb[] = [];
  let tempDir: string | null = null;

  afterEach(async () => {
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("returns reconciled chunks ordered by bm25 score within the requested limit", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/strong.md", "# Strong\n\nneedle needle needle haystack");
    await writeVaultFile(vaultRoot, "wiki/weak.md", "# Weak\n\nneedle haystack");
    await reconcileIndex(indexDb, vaultRoot);

    const results = lexicalSearch(indexDb, "needle", { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.score).toBeLessThanOrEqual(results[1]?.score ?? Number.POSITIVE_INFINITY);
    expect(results[0]).toMatchObject({
      relPath: expect.any(String),
      text: expect.stringContaining("needle"),
      score: expect.any(Number),
    });
  });

  it("treats FTS operators in user input as simple terms instead of exposing raw syntax", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/operators.md", "# Operators\n\nfoo bar a b y term no");
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "foo OR bar").map((result) => result.relPath)).toEqual(["wiki/operators.md"]);
    expect(lexicalSearch(indexDb, "a NEAR b")).toHaveLength(1);
    expect(lexicalSearch(indexDb, "a NEAR/5 b")).toHaveLength(1);
    expect(lexicalSearch(indexDb, "x:y")).toHaveLength(1);
    expect(lexicalSearch(indexDb, '"')).toEqual([]);
    expect(lexicalSearch(indexDb, "col:term")).toHaveLength(1);
    expect(lexicalSearch(indexDb, "*")).toEqual([]);
    expect(lexicalSearch(indexDb, "-no")).toHaveLength(1);
    expect(lexicalSearch(indexDb, "(")).toEqual([]);
  });

  it("returns an empty result for empty input and FTS parser errors", () => {
    const noMatchDb = {
      database: {
        prepare: () => {
          throw new Error("MATCH should not run for an empty query");
        },
      },
    } as unknown as IndexDb;
    expect(lexicalSearch(noMatchDb, "")).toEqual([]);
    expect(lexicalSearch(noMatchDb, " \t\n ")).toEqual([]);

    const malformedMatchDb = {
      database: {
        prepare: () => ({
          all: () => {
            throw new Error("unterminated string");
          },
        }),
      },
    } as unknown as IndexDb;

    expect(lexicalSearch(malformedMatchDb, "valid")).toEqual([]);
  });

  it("uses rowid as a deterministic tiebreaker when bm25 scores tie", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/a.md", "# Tie\n\nsame tie content");
    await writeVaultFile(vaultRoot, "wiki/b.md", "# Tie\n\nsame tie content");
    await writeVaultFile(vaultRoot, "wiki/c.md", "# Tie\n\nsame tie content");
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "tie").map((result) => result.relPath)).toEqual([
      "wiki/a.md",
      "wiki/b.md",
      "wiki/c.md",
    ]);
  });

  it("clamps limit to the supported range", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    for (let index = 0; index < 125; index += 1) {
      await writeVaultFile(vaultRoot, `wiki/doc-${String(index).padStart(3, "0")}.md`, "# Doc\n\nsharedterm");
    }
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "sharedterm", { limit: 0 })).toHaveLength(1);
    expect(lexicalSearch(indexDb, "sharedterm", { limit: 500 })).toHaveLength(100);
  });

  it("limits in chunks_fts before joining chunk rows", () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const fakeDb = {
      database: {
        prepare: (sql: string) => {
          capturedSql = sql.replace(/\s+/g, " ").trim();
          return {
            all: (...params: unknown[]) => {
              capturedParams = params;
              return [];
            },
          };
        },
      },
    } as unknown as IndexDb;

    expect(lexicalSearch(fakeDb, "needle", { limit: 7 })).toEqual([]);
    expect(capturedParams).toEqual(['"needle"', 7]);
    expect(capturedSql).toContain("WITH ranked AS");
    expect(capturedSql).toContain("FROM chunks_fts WHERE chunks_fts MATCH ?");
    expect(capturedSql.indexOf("LIMIT ?")).toBeLessThan(capturedSql.indexOf("JOIN chunks"));
  });

  async function createHarness(): Promise<{ vaultRoot: string; indexDb: IndexDb }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-search-"));
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
});
