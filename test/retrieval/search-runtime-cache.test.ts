import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmbeddingBody } from "../../src/retrieval/embedding-text.js";
import { loadEmbeddings, saveEmbeddings, type EmbeddingKind } from "../../src/retrieval/embeddings-store.js";
import type { EmbedRequest, Embedder } from "../../src/retrieval/embedder/types.js";
import { loadSearchCorpus } from "../../src/retrieval/corpus.js";
import { createSearchRuntimeCache, runSearch } from "../../src/retrieval/search.js";
import type { VoyageClient } from "../../src/retrieval/voyage-client.js";

describe("search runtime cache", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "search-cache-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reuses zero-pending refresh and parsed embeddings on warm search", async () => {
    await writeWikiPage(tmp, "foo", "Foo memory retrieval text.\n");
    const corpus = await loadSearchCorpus({ vaultRoot: tmp, scope: "all" });
    const document = corpus.documents[0]!;
    await mkdir(join(tmp, "embeddings"), { recursive: true });
    await saveEmbeddings(
      tmp,
      "wiki",
      [{
        path: document.relPath,
        hash: hashEmbeddingBody(document.body),
        vector: vectorForText(document.body),
        model: "test-embed",
        dim: 3,
        ts: "2026-06-04T00:00:00.000Z",
      }],
      { backupPrevious: false, expectedDim: 3 },
    );

    const embed = vi.fn(async (request: EmbedRequest) => ({
      vectors: request.texts.map(vectorForText),
      model: "test-embed",
      dim: 3,
    }));
    const embedClient: Embedder = {
      providerName: "test",
      modelName: "test-embed",
      dim: 3,
      embed,
    };
    const voyageClient: VoyageClient = {
      embed: vi.fn(),
      rerank: vi.fn(),
    };
    const embeddingLoader = vi.fn(
      async (memoryRoot: string, kind: EmbeddingKind) => loadEmbeddings(memoryRoot, kind),
    );
    const runtimeCache = createSearchRuntimeCache();

    const first = await runSearch({
      query: "foo memory",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      embeddingLoader,
      runtimeCache,
    });
    const second = await runSearch({
      query: "foo memory",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      embeddingLoader,
      runtimeCache,
    });

    expect(first.results[0]?.path).toBe("wiki/projects/foo.md");
    expect(second.results[0]?.path).toBe("wiki/projects/foo.md");
    expect(runtimeCache.stats.refreshCacheHits).toBe(1);
    expect(runtimeCache.stats.embeddingCacheHits).toBeGreaterThanOrEqual(2);
    expect(embeddingLoader.mock.calls.map((call) => call[1])).toEqual(["wiki"]);
    expect(embed.mock.calls.filter(([request]) => request.inputType === "query")).toHaveLength(2);
    expect(embed.mock.calls.filter(([request]) => request.inputType !== "query")).toHaveLength(0);
  });
});

async function writeWikiPage(root: string, slug: string, body: string): Promise<void> {
  await mkdir(join(root, "wiki", "projects"), { recursive: true });
  await writeFile(
    join(root, "wiki", "projects", `${slug}.md`),
    [
      "---",
      "type: projects",
      `title: ${slug}`,
      "status: active",
      "created: 2026-06-04",
      "updated: 2026-06-04",
      "---",
      "",
      body,
    ].join("\n"),
  );
}

function vectorForText(text: string): number[] {
  return text.toLowerCase().includes("foo") ? [0.9, 0.2, 0.1] : [0.1, 0.8, 0.2];
}
