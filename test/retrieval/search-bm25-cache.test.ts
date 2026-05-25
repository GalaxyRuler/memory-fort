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
      "embedding ".repeat(40_000) + "alpha retrieval memory",
    );
    await writeWikiPage(
      "beta.md",
      "Beta Embedding",
      "embedding ".repeat(35_000) + "beta semantic recall",
    );
    await writeWikiPage(
      "gamma.md",
      "Gamma Search",
      "search ".repeat(30_000) + "gamma lexical notes",
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  test("reuses the BM25 index until a contributing file mtime changes", async () => {
    const first = await searchEmbedding();
    const second = await searchEmbedding();

    expect(second.results.map((result) => result.path)).toEqual(
      first.results.map((result) => result.path),
    );
    expect(first.timings.bm25Ms).toBeGreaterThan(0);
    expect(second.timings.bm25Ms).toBeLessThanOrEqual(first.timings.bm25Ms / 10);

    const changedAt = new Date(Date.now() + 60_000);
    await utimes(join(vaultRoot, "wiki", "projects", "alpha.md"), changedAt, changedAt);

    const afterMtimeChange = await searchEmbedding();

    expect(afterMtimeChange.results.map((result) => result.path)).toEqual(
      first.results.map((result) => result.path),
    );
    expect(afterMtimeChange.timings.bm25Ms).toBeGreaterThanOrEqual(
      first.timings.bm25Ms / 2,
    );
  });

  async function searchEmbedding() {
    const { embedClient, voyageClient } = clients();
    return runSearch({
      query: "embedding",
      scope: "wiki",
      k: 3,
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
