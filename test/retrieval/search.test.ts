import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchDocument } from "../../src/retrieval/corpus.js";
import type { EmbedClient } from "../../src/retrieval/refresh.js";
import { runSearch } from "../../src/retrieval/search.js";
import {
  VoyageUnavailableError,
  type VoyageClient,
} from "../../src/retrieval/voyage-client.js";

describe("search core", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "search-core-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("empty corpus returns empty results, no errors", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "voyage embeddings memory system search backend",
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: [], errors: [] }),
    });

    expect(response.results).toEqual([]);
    expect(response.warnings).toEqual([]);
    expect(response.degraded).toBe(false);
    expect(response.hyde.used).toBe(false);
  });

  it("all signals contribute; results have correct shape", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "voyage",
      noHyde: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: sampleDocs(), errors: [] }),
    });

    expect(response.results.length).toBeGreaterThan(0);
    const first = response.results[0]!;
    expect(first).toEqual({
      path: expect.any(String),
      title: expect.any(String),
      snippet: expect.any(String),
      score: expect.any(Number),
      source: expect.any(String),
      sources: expect.any(Array),
      kind: expect.stringMatching(/^(wiki|raw|crystal)$/),
    });
    expect(first.sources.length).toBeGreaterThan(0);
    for (const key of [
      "corpusMs",
      "refreshMs",
      "embedQueryMs",
      "bm25Ms",
      "vectorMs",
      "exactMs",
      "graphMs",
      "metadataMs",
      "rrfMs",
      "rerankMs",
      "totalMs",
    ] as const) {
      expect(response.timings[key]).toEqual(expect.any(Number));
    }
  });

  it("Voyage failure sets degraded=true and falls back to RRF", async () => {
    const { embedClient, voyageClient } = clients({
      rerank: async () => {
        throw new VoyageUnavailableError("network down");
      },
    });

    const response = await runSearch({
      query: "voyage",
      noHyde: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: sampleDocs(), errors: [] }),
    });

    expect(response.degraded).toBe(true);
    expect(response.warnings.some((warning) => warning.includes("rerank"))).toBe(
      true,
    );
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0]?.source).not.toBe("rerank");
  });

  it("scope filter respected", async () => {
    const { embedClient, voyageClient } = clients();
    const documents = [
      ...sampleDocs().slice(0, 3),
      makeDoc({
        kind: "raw",
        relPath: "raw/2026-05-23/codex-1.md",
        title: "Raw one",
        type: "raw-session",
        body: "voyage raw session notes",
      }),
      makeDoc({
        kind: "raw",
        relPath: "raw/2026-05-23/codex-2.md",
        title: "Raw two",
        type: "raw-session",
        body: "voyage raw troubleshooting",
      }),
    ];

    const wiki = await runSearch({
      query: "voyage",
      noHyde: true,
      scope: "wiki",
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });
    const raw = await runSearch({
      query: "voyage",
      noHyde: true,
      scope: "raw",
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    expect(wiki.results.length).toBeGreaterThan(0);
    expect(wiki.results.every((result) => result.kind === "wiki")).toBe(true);
    expect(raw.results.length).toBeGreaterThan(0);
    expect(raw.results.every((result) => result.kind === "raw")).toBe(true);
  });

  it("k parameter limits output", async () => {
    const { embedClient, voyageClient } = clients();
    const documents = Array.from({ length: 20 }, (_, index) =>
      makeDoc({
        relPath: `wiki/projects/voyage-${index}.md`,
        title: `Voyage ${index}`,
        body: `voyage embeddings memory system document ${index}`,
        tags: ["voyage"],
      }),
    );

    const response = await runSearch({
      query: "voyage",
      noHyde: true,
      k: 5,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    expect(response.results.length).toBeLessThanOrEqual(5);
  });

  it("runSearch excludes metadata-only results", async () => {
    const { voyageClient } = clients();
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(() => [0, 0, 0]),
      model: "test-embed",
      dim: 3,
    }));
    const documents = [
      makeDoc({
        relPath: "wiki/decisions/no-vector-db.md",
        title: "No vector database",
        body: "no vector database deployment note",
        tags: [],
      }),
      makeDoc({
        relPath: "wiki/projects/beta.md",
        title: "Beta",
        body: "beta body with unrelated notes",
        tags: [],
      }),
    ];

    const response = await runSearch({
      query: "xyzqwerty_no_such_term_anywhere",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient: { embed } as EmbedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    expect(response.results).toEqual([]);
  });

  it("noHyde skips HyDE even for short query", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "voyage",
      noHyde: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: sampleDocs(), errors: [] }),
    });

    expect(response.hyde.used).toBe(false);
    expect(response.hyde.reason).toBe("disabled-by-flag");
    expect(embedClient.embed).toHaveBeenCalledWith(
      ["voyage"],
      expect.objectContaining({ inputType: "query" }),
    );
  });

  it("hydeExpansion supplied bypasses heuristic", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "voyage",
      hydeExpansion: "Voyage AI is an embedding provider used by memory-system.",
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: sampleDocs(), errors: [] }),
    });

    expect(response.hyde.used).toBe(true);
    expect(response.hyde.reason).toBe("applied");
    expect(embedClient.embed).toHaveBeenCalledWith(
      ["Voyage AI is an embedding provider used by memory-system."],
      expect.objectContaining({ inputType: "query" }),
    );
  });
});

function clients(overrides: { rerank?: VoyageClient["rerank"] } = {}): {
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
      rerank:
        overrides.rerank ??
        vi.fn(async (_query, documents) => ({
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

function sampleDocs(): SearchDocument[] {
  return [
    makeDoc({
      relPath: "wiki/tools/voyageai.md",
      title: "Voyage AI",
      body: "voyage embeddings provider for semantic search",
      tags: ["voyage", "embeddings"],
      relations: { mentioned_in: ["wiki/projects/memory-system.md"] },
    }),
    makeDoc({
      relPath: "wiki/projects/memory-system.md",
      title: "Memory System",
      body: "memory system phase three uses voyage embeddings",
      tags: ["phase3"],
      relations: { uses: ["wiki/tools/voyageai.md"] },
    }),
    makeDoc({
      relPath: "wiki/decisions/voyage-choice.md",
      title: "Voyage embeddings decision",
      body: "decision to use voyage for embeddings and rerank",
      tags: ["decision"],
    }),
    makeDoc({
      relPath: "wiki/lessons/vector-search.md",
      title: "Vector search lessons",
      body: "semantic retrieval combines vectors with lexical ranking",
      tags: ["retrieval"],
    }),
    makeDoc({
      relPath: "wiki/references/phase3.md",
      title: "Phase 3 reference",
      body: "phase three retrieval references voyage and memory search",
      tags: ["reference"],
    }),
  ];
}

function makeDoc(overrides: Partial<SearchDocument>): SearchDocument {
  const relPath = overrides.relPath ?? "wiki/projects/default.md";
  const title = overrides.title ?? "Default";
  const body = overrides.body ?? "default body";
  return {
    kind: overrides.kind ?? "wiki",
    relPath,
    fullPath: overrides.fullPath ?? `C:/tmp/${relPath}`,
    title,
    type: overrides.type ?? "projects",
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 0.9,
    tags: overrides.tags ?? [],
    relations: overrides.relations ?? {},
    source: overrides.source ?? "manual",
    session: overrides.session ?? null,
    body,
    snippetSource: overrides.snippetSource ?? body.slice(0, 240),
    mtime: overrides.mtime ?? "2026-05-23T00:00:00.000Z",
    updated: overrides.updated ?? "2026-05-23",
    sizeBytes: overrides.sizeBytes ?? body.length,
  };
}

function vectorForText(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("voyage")) return [1, 0, 0];
  if (lower.includes("semantic") || lower.includes("vector")) return [0.8, 0.2, 0];
  return [0, 1, 0];
}
