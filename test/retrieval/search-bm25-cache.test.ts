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
    expect(first.timings.bm25Ms).toBeGreaterThan(0);
    expect(second.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);

    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, "wiki", "projects", "alpha.md"), changedAt, changedAt);

    const afterMtimeChange = await searchEmbedding();

    expect(resultPaths(afterMtimeChange)).toEqual(resultPaths(first));
    expect(afterMtimeChange.timings.bm25Ms).toBeGreaterThan(second.timings.bm25Ms);
    expect(afterMtimeChange.timings.bm25Ms).toBeLessThanOrEqual(200);
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

    expect(warm.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);
    expect(afterAdd.results.some((result) => result.path.endsWith("zeta.md"))).toBe(true);
    expect(afterAdd.timings.bm25Ms).toBeLessThanOrEqual(200);
    expect(afterAdd.timings.bm25Ms).toBeLessThan(first.timings.bm25Ms / 2);
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

    expect(warm.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);
    expect(afterModify.results.some((result) => result.path.endsWith("beta.md"))).toBe(true);
    expect(afterModify.timings.bm25Ms).toBeLessThanOrEqual(200);
    expect(afterModify.timings.bm25Ms).toBeLessThan(first.timings.bm25Ms / 2);
  });

  test("ignores non-corpus sidecar mtime touches for BM25 cache reuse", async () => {
    const first = await searchEmbedding();
    const warm = await searchEmbedding();
    await writeFile(join(vaultRoot, ".sync-state.json"), "{}\n", "utf-8");
    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, ".sync-state.json"), changedAt, changedAt);

    const afterSidecarTouch = await searchEmbedding();

    expect(warm.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);
    expect(resultPaths(afterSidecarTouch)).toEqual(resultPaths(first));
    expect(afterSidecarTouch.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);
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
