import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/dashboard/server.js";
import { openIndexDb, type IndexDb } from "../../src/index/db.js";
import { reconcileIndex } from "../../src/index/reconcile.js";

const GOLDEN_QUERIES = [
  {
    query: "aurora checksum",
    expectedPath: "wiki/golden/alpha.md",
  },
  {
    query: "wal reconcile latency",
    expectedPath: "wiki/golden/beta.md",
  },
  {
    query: "operator phase3 runbook",
    expectedPath: "wiki/golden/gamma.md",
  },
] as const;

describe("dashboard golden query drift", () => {
  let tempDir: string | null = null;
  let server: RunningServer | null = null;
  const openDbs: IndexDb[] = [];
  const previousSentinel = process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"];

  afterEach(async () => {
    await server?.close();
    server = null;
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
    if (previousSentinel === undefined) {
      delete process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"];
    } else {
      process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"] = previousSentinel;
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("keeps expected hits present in both legacy and index paths without using the legacy loader in index mode", async () => {
    const { vaultRoot, indexDbPath, sentinelPath } = await createGoldenVault();

    delete process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"];
    server = await createServer({
      vaultRoot,
      port: 0,
      env: { ...process.env, MEMORY_INDEX_SEARCH: "0" },
      voyageClient: null,
    });
    for (const golden of GOLDEN_QUERIES) {
      const body = await search(server, golden.query, "legacy");
      expect(paths(body)).toContain(golden.expectedPath);
    }
    await server.close();
    server = null;

    process.env["MEMORY_LOAD_SEARCH_CORPUS_SENTINEL"] = sentinelPath;
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
    for (const golden of GOLDEN_QUERIES) {
      const body = await search(server, golden.query, "index");
      expect(paths(body)).toContain(golden.expectedPath);
      expect(body.results.some((result) => result.path === golden.expectedPath && result.source === "index")).toBe(true);
    }

    await expect(readFile(sentinelPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  async function createGoldenVault(): Promise<{
    vaultRoot: string;
    indexDbPath: string;
    sentinelPath: string;
  }> {
    tempDir = await mkdtemp(join(tmpdir(), "memory-index-golden-drift-"));
    const vaultRoot = join(tempDir, "vault");
    await writeVaultFile(
      vaultRoot,
      "wiki/golden/alpha.md",
      "# Alpha\n\nThe aurora checksum note anchors the fixed golden query set for legacy and index search.",
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/golden/beta.md",
      "# Beta\n\nThe wal reconcile latency note tracks the Task 6 installed app drift harness.",
    );
    await writeVaultFile(
      vaultRoot,
      "wiki/golden/gamma.md",
      "# Gamma\n\nThe operator phase3 runbook note records that Part B is a separate real-vault run.",
    );

    const indexDbPath = join(tempDir, "index", "index.db");
    const indexDb = openIndexDb(indexDbPath);
    openDbs.push(indexDb);
    await reconcileIndex(indexDb, vaultRoot);
    indexDb.close();
    openDbs.pop();

    return {
      vaultRoot,
      indexDbPath,
      sentinelPath: join(tempDir, "legacy-loadSearchCorpus.invocations.jsonl"),
    };
  }

  async function search(
    running: RunningServer,
    query: string,
    mode: "legacy" | "index",
  ): Promise<{ results: Array<{ path: string; source?: string }> }> {
    const url = new URL(`http://${running.host}:${running.port}/api/search`);
    url.searchParams.set("q", query);
    if (mode === "legacy") {
      url.searchParams.set("scope", "all");
      url.searchParams.set("k", "5");
      url.searchParams.set("noHyde", "true");
      url.searchParams.set("noRerank", "true");
    } else {
      url.searchParams.set("limit", "5");
    }
    const response = await fetch(url);
    expect(response.status).toBe(200);
    return await response.json() as { results: Array<{ path: string; source?: string }> };
  }

  function paths(body: { results: Array<{ path: string }> }): string[] {
    return body.results.map((result) => result.path);
  }

  async function writeVaultFile(vaultRoot: string, relPath: string, content: string): Promise<void> {
    const path = join(vaultRoot, ...relPath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
});
