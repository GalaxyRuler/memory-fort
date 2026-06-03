import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      "graphSpreadMs",
      "metadataMs",
      "rrfMs",
      "rerankMs",
      "totalMs",
    ] as const) {
      expect(response.timings[key]).toEqual(expect.any(Number));
    }
    expect(response.timings.intentClassification).toMatchObject({
      label: "open-ended",
      method: "fallback",
    });
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

  it("accepts explicit intent and exposes it in timings", async () => {
    const { embedClient, voyageClient } = clients();

    const response = await runSearch({
      query: "deploy dashboard",
      intent: "procedure",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents: sampleDocs(), errors: [] }),
    });

    expect(response.timings.intentClassification).toMatchObject({
      label: "procedure",
      method: "explicit",
      confidence: 1,
    });
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

  it("adds spreading activation as a separate graph-spread RRF source", async () => {
    const { embedClient, voyageClient } = clients();
    const documents = [
      makeDoc({
        relPath: "wiki/projects/react.md",
        title: "React",
        body: "react component recall seed",
        relations: { relates: ["wiki/lessons/hooks.md"] },
      }),
      makeDoc({
        relPath: "wiki/lessons/hooks.md",
        title: "Hooks",
        body: "unrelated child node",
      }),
    ];

    const response = await runSearch({
      query: "react recall",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    const child = response.results.find(
      (result) => result.path === "wiki/lessons/hooks.md",
    );
    expect(response.timings.graphSpreadMs).toEqual(expect.any(Number));
    expect(child?.sources.some((source) => source.source === "graph-spread")).toBe(
      true,
    );
  });

  it("passes config edge weight overrides into spreading activation", async () => {
    const { embedClient, voyageClient } = clients();
    const documents = [
      makeDoc({
        relPath: "wiki/issues/cache-outage.md",
        title: "Cache outage",
        type: "issues",
        body: "voyage cache outage incident seed",
        relations: {
          caused_by: ["wiki/aaa/slow-cache.md"],
          linked: ["wiki/references/z-cache-note.md"],
        },
      }),
      makeDoc({
        relPath: "wiki/aaa/slow-cache.md",
        title: "Slow cache",
        type: "tools",
        body: "unrelated causal neighbor",
      }),
      makeDoc({
        relPath: "wiki/references/z-cache-note.md",
        title: "Cache note",
        type: "references",
        body: "unrelated linked neighbor",
      }),
    ];

    const response = await runSearch({
      query: "voyage cache outage incident",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
      configLoader: async () => ({
        graph: { edge_weights: { linked: 2, caused_by: 0.5 } },
      }),
    });

    const linked = response.results.find(
      (result) => result.path === "wiki/references/z-cache-note.md",
    );
    const causedBy = response.results.find(
      (result) => result.path === "wiki/aaa/slow-cache.md",
    );
    const linkedGraphRank = linked?.sources.find((source) => source.source === "graph-spread")?.rank;
    const causedByGraphRank = causedBy?.sources.find((source) => source.source === "graph-spread")?.rank;

    expect(linkedGraphRank).toBeGreaterThan(0);
    expect(causedByGraphRank).toBeGreaterThan(0);
    expect(linkedGraphRank).toBeLessThan(causedByGraphRank!);
  });

  it("returns freshly-added raw files lexically when embeddings are unavailable", async () => {
    await mkdir(join(tmp, "raw", "2026-05-29"), { recursive: true });
    await writeFile(
      join(tmp, "raw", "2026-05-29", "manual-fresh.md"),
      [
        "---",
        "type: raw-session",
        "title: manual fresh",
        "created: 2026-05-29",
        "updated: 2026-05-29",
        "source: manual",
        "session: fresh",
        "---",
        "",
        "## [12:00:00] Observation",
        "",
        "_tags: project · confidence: 1 · observed_at: 2026-05-29T12:00:00.000Z_",
        "",
        "FRESH-LEXICAL-4-8 exact token should be searchable immediately.",
      ].join("\n"),
    );
    const embedClient: EmbedClient = {
      embed: vi.fn(async () => {
        throw new Error("embedder unavailable");
      }),
    };
    const voyageClient: VoyageClient = {
      embed: vi.fn(async () => {
        throw new Error("embedder unavailable");
      }),
      rerank: vi.fn(async () => {
        throw new Error("rerank unavailable");
      }),
    };

    const response = await runSearch({
      query: "FRESH-LEXICAL-4-8",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
    });

    expect(response.degraded).toBe(true);
    expect(response.results[0]?.path).toBe("raw/2026-05-29/manual-fresh.md");
    expect(response.results[0]?.sources.some((source) => source.source === "bm25")).toBe(true);
  });

  it("bounds query-time embedding refresh work for a large stale backlog", async () => {
    const { voyageClient } = clients();
    const embed = vi.fn(async (texts: string[]) => ({
      vectors: texts.map(vectorForText),
      model: "test-embed",
      dim: 3,
    }));
    const documents = Array.from({ length: 20 }, (_, index) =>
      makeDoc({
        relPath: `wiki/projects/backlog-${index}.md`,
        title: `Backlog ${index}`,
        body: index === 19
          ? "rare-bounded-refresh-token"
          : `backlog document ${index}`,
      }),
    );

    const response = await runSearch({
      query: "rare-bounded-refresh-token",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient: { embed } as EmbedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    expect(response.results[0]?.path).toBe("wiki/projects/backlog-19.md");
    expect(response.warnings.some((warning) => warning.includes("embedding refresh skipped 12 pending documents"))).toBe(true);
    const documentRefreshCalls = embed.mock.calls.filter(
      (call) => (call[1] as { inputType?: string } | undefined)?.inputType !== "query",
    );
    expect(documentRefreshCalls).toHaveLength(1);
    expect(documentRefreshCalls[0]?.[0]).toHaveLength(8);
  });

  it("keeps oversized raw BM25 work bounded while preserving tail search", async () => {
    const embedClient: EmbedClient = {
      embed: vi.fn(async () => {
        throw new Error("embedder unavailable");
      }),
    };
    const voyageClient: VoyageClient = {
      embed: vi.fn(async () => {
        throw new Error("embedder unavailable");
      }),
      rerank: vi.fn(async () => {
        throw new Error("rerank unavailable");
      }),
    };
    const documents = Array.from({ length: 100 }, (_, index) => {
      const body = [
        `raw heading ${index}`,
        "middle ".repeat(30_000),
        index === 42 ? "tailneedle42" : `tail-other-${index}`,
      ].join("\n");
      return makeDoc({
        kind: "raw",
        relPath: `raw/2026-05-29/manual-large-${index}.md`,
        title: `large raw ${index}`,
        type: "raw-session",
        body,
        snippetSource: `raw heading ${index}`,
        sizeBytes: body.length,
      });
    });

    const response = await runSearch({
      query: "tailneedle42",
      noHyde: true,
      noRerank: true,
      vaultRoot: tmp,
      embedClient,
      voyageClient,
      corpusLoader: async () => ({ documents, errors: [] }),
    });

    expect(response.results[0]?.path).toBe("raw/2026-05-29/manual-large-42.md");
    expect(response.results[0]?.sources.some((source) => source.source === "bm25")).toBe(true);
    expect(response.timings.bm25Ms).toBeLessThanOrEqual(100);
  });

  it("can disable spreading activation with MEMORY_FORT_SPREADING_ACTIVATION", async () => {
    const previous = process.env.MEMORY_FORT_SPREADING_ACTIVATION;
    process.env.MEMORY_FORT_SPREADING_ACTIVATION = "false";
    const { embedClient, voyageClient } = clients();
    const documents = [
      makeDoc({
        relPath: "wiki/projects/react.md",
        title: "React",
        body: "react component recall seed",
        relations: { relates: ["wiki/lessons/hooks.md"] },
      }),
      makeDoc({
        relPath: "wiki/lessons/hooks.md",
        title: "Hooks",
        body: "unrelated child node",
      }),
    ];

    try {
      const response = await runSearch({
        query: "react recall",
        noHyde: true,
        noRerank: true,
        vaultRoot: tmp,
        embedClient,
        voyageClient,
        corpusLoader: async () => ({ documents, errors: [] }),
      });

      expect(response.timings.graphSpreadMs).toEqual(expect.any(Number));
      expect(
        response.results.some((result) =>
          result.sources.some((source) => source.source === "graph-spread"),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.MEMORY_FORT_SPREADING_ACTIVATION;
      } else {
        process.env.MEMORY_FORT_SPREADING_ACTIVATION = previous;
      }
    }
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
