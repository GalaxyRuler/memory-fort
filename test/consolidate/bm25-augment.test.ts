import { describe, expect, it } from "vitest";
import {
  combineMentions,
  findBM25Mentions,
} from "../../src/consolidate/bm25-augment.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";
import type { Match } from "../../src/consolidate/title-index.js";

describe("BM25 consolidation augmentation", () => {
  it("finds unmistakable wiki topics when the title is not mentioned verbatim", () => {
    const matches = findBM25Mentions(
      [
        "The embedding provider decision came up again.",
        "We discussed retrieval quality, vector search, reranking, and semantic recall.",
        "Voyage models stayed attractive for embeddings because retrieval recall improved.",
      ].join(" "),
      [
        wiki(
          "wiki/decisions/voyage-ai-for-embeddings.md",
          "Provider choice",
          "Embeddings retrieval semantic recall reranking vector search Voyage models provider decision embeddings retrieval.",
        ),
        wiki(
          "wiki/projects/dashboard-polish.md",
          "Dashboard polish",
          "React cards sidebar route transitions visual layout navigation density.",
        ),
      ],
      { threshold: 5 },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.relPath).toBe("wiki/decisions/voyage-ai-for-embeddings.md");
    expect(matches[0]!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(matches[0]!.confidence).toBeLessThanOrEqual(0.8);
  });

  it("does not propose audit logs as semantic consolidation targets", () => {
    const matches = findBM25Mentions(
      "agentmemory migration imported memories from a legacy stream store",
      [
        wiki(
          "wiki/.audit/agentmemory-migration-2026-05-26.md",
          "agentmemory migration audit",
          "agentmemory migration imported legacy stream store entries",
        ),
        wiki(
          "wiki/projects/agentmemory.md",
          "agentmemory",
          "agentmemory legacy plugin migration and memory import strategy",
        ),
      ],
      { threshold: 0.1 },
    );

    expect(matches.map((match) => match.relPath)).toEqual([
      "wiki/projects/agentmemory.md",
    ]);
  });

  it("scores only wiki pages and caps results to topK", () => {
    const matches = findBM25Mentions(
      "retrieval embeddings graph graph search search dashboard dashboard",
      [
        wiki("wiki/decisions/graph-search.md", "Graph search", "graph graph graph search retrieval"),
        wiki("wiki/decisions/dashboard-search.md", "Dashboard search", "dashboard dashboard search retrieval"),
        wiki("wiki/decisions/embedding-search.md", "Embedding search", "embeddings embeddings search retrieval"),
        raw("raw/2026-05-27/codex-session.md", "Codex session", "graph graph graph graph search retrieval"),
      ],
      { threshold: 0.1, topK: 2 },
    );

    expect(matches).toHaveLength(2);
    expect(matches.every((match) => match.relPath.startsWith("wiki/"))).toBe(true);
  });

  it("merges lexical and BM25 hits by keeping the stronger confidence and source both", () => {
    const lexical: Match[] = [{
      relPath: "wiki/decisions/voyage-ai-for-embeddings.md",
      title: "Voyage AI",
      position: 10,
      confidence: 0.85,
    }];
    const bm25 = findBM25Mentions(
      "embeddings retrieval semantic recall reranking Voyage provider decision",
      [
        wiki(
          "wiki/decisions/voyage-ai-for-embeddings.md",
          "Voyage AI for embeddings",
          "embeddings retrieval semantic recall reranking Voyage provider decision",
        ),
      ],
      { threshold: 0.1 },
    );

    const combined = combineMentions(lexical, bm25);

    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({
      relPath: "wiki/decisions/voyage-ai-for-embeddings.md",
      confidence: 0.85,
      source: "both",
    });
  });
});

function wiki(relPath: string, title: string, body: string): SearchDocument {
  return doc("wiki", relPath, title, body);
}

function raw(relPath: string, title: string, body: string): SearchDocument {
  return doc("raw", relPath, title, body);
}

function doc(
  kind: "wiki" | "raw",
  relPath: string,
  title: string,
  body: string,
): SearchDocument {
  return {
    kind,
    relPath,
    fullPath: relPath,
    title,
    type: kind === "wiki" ? "decisions" : "raw-session",
    status: "active",
    cognitiveType: kind === "wiki" ? "semantic" : "episodic",
    confidence: null,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    importedFrom: null,
    body,
    snippetSource: body,
    created: null,
    observedAt: null,
    updated: null,
    mtime: "2026-05-27T00:00:00.000Z",
    sizeBytes: body.length,
    rawFrontmatter: null,
  };
}
