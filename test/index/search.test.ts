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
    expect(lexicalSearch(indexDb, "-term")).toHaveLength(1);
    expect(lexicalSearch(indexDb, "(")).toEqual([]);
  });

  it("relaxes multi-term user queries so partial curated-page matches are still returned", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/projects/memory-system.md", "# Memory System\n\ncross-tool file-system memory fort project");
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "cross-tool file-system memory fort project deployment plan").map((result) => result.relPath))
      .toContain("wiki/projects/memory-system.md");
  });

  it("prefers curated wiki pages over raw transcripts with comparable lexical matches", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/tools/voyageai.md", "# Voyage AI\n\nVoyage embeddings and rerank provider notes.");
    await writeVaultFile(
      vaultRoot,
      "raw/2026-07-03/transcript.md",
      `# Transcript\n\n${"voyage embeddings provider raw transcript ".repeat(20)}`,
    );
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "voyage embeddings provider").map((result) => result.relPath)[0])
      .toBe("wiki/tools/voyageai.md");
  });

  it("prefers canonical wiki pages over archive and proposed wiki paths", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/projects/current.md", "# Current\n\nneedle");
    await writeVaultFile(vaultRoot, "wiki/compile-proposed/current.md", "# Proposed\n\nneedle needle needle");
    await writeVaultFile(vaultRoot, "wiki/archive/current.md", "# Archived\n\nneedle needle needle needle");
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "needle").map((result) => result.relPath)[0])
      .toBe("wiki/projects/current.md");
  });

  it("demotes archived frontmatter after lexical candidate aggregation", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/a-archived.md",
      [
        "---",
        "title: Archived",
        "type: projects",
        "status: archived",
        "confidence: 1",
        "updated: 2026-07-01",
        "---",
        "",
        "# Archived",
        "",
        "needle ".repeat(30),
      ].join("\n"),
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/z-active.md",
      [
        "---",
        "title: Active",
        "type: projects",
        "status: active",
        "confidence: 1",
        "updated: 2026-07-01",
        "---",
        "",
        "# Active",
        "",
        "needle",
      ].join("\n"),
    );
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "needle").map((result) => result.relPath)[0])
      .toBe("wiki/projects/z-active.md");
  });

  it("uses path terms to break toward the intended curated page", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/threads/acme-project-testing-configuration-enhancements.md", "# Acme\n\ntesting updates");
    await writeVaultFile(
      vaultRoot,
      "wiki/threads/zenith-project-testing-configuration-enhancements.md",
      `# Zenith\n\n${"testing configuration enhancements ".repeat(12)}`,
    );
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "Acme testing configuration enhancements").map((result) => result.relPath)[0])
      .toBe("wiki/threads/acme-project-testing-configuration-enhancements.md");
  });

  it("uses relPath fallback candidates when the unique term is not in chunk text", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/lessons/powershell-safe-vars.md", "# Safe Vars\n\nquoted command guidance");
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "fragile PowerShell variable quoting lesson").map((result) => result.relPath)[0])
      .toBe("wiki/lessons/powershell-safe-vars.md");
  });

  it("does not route by folder vocabulary when another document has stronger lexical evidence", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(
      vaultRoot,
      "wiki/projects/memory-system.md",
      "# Memory System\n\nvoyage embeddings reranking provider dependency orchestration orchestration",
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/lessons/general-retrieval-note.md",
      "# General Retrieval Note\n\nvoyage embeddings reranking provider dependency",
    );
    await reconcileIndex(indexDb, vaultRoot);

    expect(lexicalSearch(indexDb, "which lesson identifies voyage embeddings reranking provider dependency orchestration").map((result) => result.relPath)[0])
      .toBe("wiki/projects/memory-system.md");
  });

  it("returns the best chunk per document instead of letting one file occupy multiple ranks", async () => {
    const { vaultRoot, indexDb } = await createHarness();
    await writeVaultFile(vaultRoot, "wiki/multi.md", "# Multi\n\nneedle first paragraph.\n\nneedle second paragraph.");
    await writeVaultFile(vaultRoot, "wiki/other.md", "# Other\n\nneedle other page.");
    await reconcileIndex(indexDb, vaultRoot, {
      chunkOptions: { maxTokens: 3, overlapTokens: 0, maxChunkChars: 32 },
    });

    const paths = lexicalSearch(indexDb, "needle", { limit: 10 }).map((result) => result.relPath);

    expect(paths.filter((path) => path === "wiki/multi.md")).toHaveLength(1);
    expect(paths).toContain("wiki/other.md");
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
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    const fakeDb = {
      database: {
        prepare: (sql: string) => {
          const statementIndex = capturedSql.length;
          capturedSql.push(sql.replace(/\s+/g, " ").trim());
          return {
            all: (...params: unknown[]) => {
              capturedParams[statementIndex] = params;
              return [];
            },
          };
        },
      },
    } as unknown as IndexDb;

    expect(lexicalSearch(fakeDb, "needle", { limit: 7 })).toEqual([]);
    expect(capturedParams[0]).toEqual(['"needle"', 140, 140]);
    expect(capturedParams[1]).toEqual(["%needle%", 140]);
    expect(capturedSql[0]).toContain("WITH matched AS");
    expect(capturedSql[0]).toContain("ranked AS");
    expect(capturedSql[0]).toContain("FROM chunks_fts WHERE chunks_fts MATCH ?");
    expect(capturedSql[0]!.indexOf("LIMIT ?")).toBeLessThan(capturedSql[0]!.indexOf("JOIN chunks"));
    expect(capturedSql[1]).toContain("matched_files AS");
    expect(capturedSql[1]).toContain("FROM files");
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
