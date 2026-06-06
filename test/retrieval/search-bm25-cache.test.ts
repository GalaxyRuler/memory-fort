import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { EmbedClient } from "../../src/retrieval/refresh.js";
import { runSearch } from "../../src/retrieval/search.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";

describe("search BM25 cache", () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "search-bm25-cache-"));
    await mkdir(join(vaultRoot, "wiki", "projects"), { recursive: true });
    await writeWikiPage(
      "alpha.md",
      "Alpha Embedding",
      largeBody("embedding", "alpha retrieval memory"),
    );
    await writeWikiPage(
      "beta.md",
      "Beta Embedding",
      largeBody("embedding", "beta semantic recall"),
    );
    await writeWikiPage(
      "gamma.md",
      "Gamma Search",
      largeBody("search", "gamma lexical notes"),
    );
    await writeWikiPage(
      "delta.md",
      "Delta Embedding",
      largeBody("embedding", "delta cache notes"),
    );
    await writeWikiPage(
      "epsilon.md",
      "Epsilon Search",
      largeBody("search", "epsilon sidecar notes"),
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  test("reuses cached BM25 work until a contributing source file mtime changes", async () => {
    const first = await searchEmbedding();
    const second = await searchEmbedding();

    expect(resultPaths(second)).toEqual(resultPaths(first));
    // Cold build: index cache miss, every source file tokenized fresh.
    expect(first.bm25Cache.indexCacheHit).toBe(false);
    expect(first.bm25Cache.tokenCacheMisses).toBe(first.bm25Cache.documentCount);
    // Fully warm: identical corpus fingerprint reuses the cached index outright.
    expect(second.bm25Cache.indexCacheHit).toBe(true);

    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, "wiki", "projects", "alpha.md"), changedAt, changedAt);

    const afterMtimeChange = await searchEmbedding();

    expect(resultPaths(afterMtimeChange)).toEqual(resultPaths(first));
    // One file's mtime changed: index rebuilds, only that file re-tokenizes.
    expect(afterMtimeChange.bm25Cache.indexCacheHit).toBe(false);
    expect(afterMtimeChange.bm25Cache.tokenCacheMisses).toBe(1);
    expect(afterMtimeChange.bm25Cache.tokenCacheHits).toBe(
      afterMtimeChange.bm25Cache.documentCount - 1,
    );
  });

  test("keeps a single source file add mostly warm", async () => {
    const first = await searchEmbedding();
    const warm = await searchEmbedding();
    await writeWikiPage(
      "zeta.md",
      "Zeta Embedding",
      largeBody("embedding", "zeta new source note"),
    );

    const afterAdd = await searchEmbedding();

    expect(warm.bm25Cache.indexCacheHit).toBe(true);
    expect(afterAdd.results.some((result) => result.path.endsWith("zeta.md"))).toBe(true);
    // Adding one file invalidates the index but keeps every prior file warm:
    // only the new file tokenizes, the rest reuse cached tokens.
    expect(afterAdd.bm25Cache.indexCacheHit).toBe(false);
    expect(afterAdd.bm25Cache.tokenCacheMisses).toBe(1);
    expect(afterAdd.bm25Cache.tokenCacheHits).toBe(first.bm25Cache.documentCount);
  });

  test("keeps a single source file modify mostly warm", async () => {
    const first = await searchEmbedding();
    const warm = await searchEmbedding();
    await writeWikiPage(
      "beta.md",
      "Beta Embedding",
      largeBody("embedding", "beta modified semantic recall"),
    );
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, "wiki", "projects", "beta.md"), changedAt, changedAt);

    const afterModify = await searchEmbedding();

    expect(warm.bm25Cache.indexCacheHit).toBe(true);
    expect(afterModify.results.some((result) => result.path.endsWith("beta.md"))).toBe(true);
    // Modifying one file invalidates the index but keeps the rest warm:
    // only the changed file re-tokenizes.
    expect(afterModify.bm25Cache.indexCacheHit).toBe(false);
    expect(afterModify.bm25Cache.tokenCacheMisses).toBe(1);
    expect(afterModify.bm25Cache.tokenCacheHits).toBe(
      afterModify.bm25Cache.documentCount - 1,
    );
  });

  test("ignores non-corpus sidecar mtime touches for BM25 cache reuse", async () => {
    const first = await searchEmbedding();
    const warm = await searchEmbedding();
    await writeFile(join(vaultRoot, ".sync-state.json"), "{}\n", "utf-8");
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, ".sync-state.json"), changedAt, changedAt);

    const afterSidecarTouch = await searchEmbedding();

    expect(warm.bm25Cache.indexCacheHit).toBe(true);
    expect(resultPaths(afterSidecarTouch)).toEqual(resultPaths(first));
    // Touching a non-corpus sidecar leaves the fingerprint unchanged: still warm.
    expect(afterSidecarTouch.bm25Cache.indexCacheHit).toBe(true);
  });

  async function searchEmbedding() {
    const { embedClient, voyageClient } = clients();
    return runSearch({
      query: "embedding",
      scope: "wiki",
      k: 10,
      noHyde: true,
      noRerank: true,
      vaultRoot,
      embedClient,
      voyageClient,
    });
  }

  async function writeWikiPage(filename: string, title: string, body: string) {
    await writeFile(
      join(vaultRoot, "wiki", "projects", filename),
      `---\ntitle: ${title}\ntype: projects\nstatus: active\nconfidence: 0.9\n---\n${body}\n`,
      "utf-8",
    );
  }

  function largeBody(term: string, suffix: string): string {
    return `${term} `.repeat(55_000) + suffix;
  }

  function resultPaths(result: Awaited<ReturnType<typeof searchEmbedding>>): string[] {
    return result.results.map((item) => item.path).sort();
  }
});

function clients(): {
  embedClient: EmbedClient & { embed: ReturnType<typeof vi.fn> };
  voyageClient: VoyageClient;
} {
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map(vectorForText),
    model: "test-embed",
    dim: 3,
  }));
  return {
    embedClient: { embed } as EmbedClient & { embed: ReturnType<typeof vi.fn> },
    voyageClient: {
      embed,
      rerank: vi.fn(async (_query, documents) => ({
        ranked: documents.map((document, index) => ({
          index,
          score: 1 - index * 0.1,
          document,
        })),
        model: "rerank-test",
      })),
    },
  };
}

function vectorForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("embedding")) return [1, 0, 0];
  if (lower.includes("search")) return [0, 1, 0];
  return [0, 0, 1];
}
