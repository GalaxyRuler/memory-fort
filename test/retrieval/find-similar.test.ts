import { describe, it, expect } from "vitest";
import { findSimilar, type EmbeddingRecord } from "../../src/retrieval/embeddings-store.js";

function makeRecord(path: string, vector: number[]): EmbeddingRecord {
  return {
    path,
    hash: "abc",
    vector,
    model: "test",
    dim: vector.length,
    ts: "2026-06-09T00:00:00Z",
  };
}

describe("findSimilar", () => {
  it("returns records above threshold sorted by similarity", () => {
    const query = [1, 0, 0];
    const records = [
      makeRecord("wiki/close.md", [0.9, 0.1, 0]),     // cosine ~0.99
      makeRecord("wiki/medium.md", [0.5, 0.5, 0.5]),   // cosine ~0.58
      makeRecord("wiki/far.md", [0, 0, 1]),             // cosine = 0
    ];

    const results = findSimilar(query, records, { threshold: 0.5, topK: 10 });

    expect(results).toHaveLength(2);
    expect(results[0].path).toBe("wiki/close.md");
    expect(results[1].path).toBe("wiki/medium.md");
  });

  it("respects topK limit", () => {
    const query = [1, 0, 0];
    const records = [
      makeRecord("wiki/a.md", [0.9, 0.1, 0]),
      makeRecord("wiki/b.md", [0.8, 0.2, 0]),
      makeRecord("wiki/c.md", [0.7, 0.3, 0]),
    ];

    const results = findSimilar(query, records, { threshold: 0.5, topK: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns empty array when no records above threshold", () => {
    const query = [1, 0, 0];
    const records = [makeRecord("wiki/far.md", [0, 0, 1])];
    const results = findSimilar(query, records, { threshold: 0.9, topK: 10 });
    expect(results).toEqual([]);
  });

  it("skips archived records", () => {
    const query = [1, 0, 0];
    const records = [
      { ...makeRecord("wiki/archived.md", [0.95, 0.05, 0]), archived: true },
      makeRecord("wiki/active.md", [0.8, 0.2, 0]),
    ];
    const results = findSimilar(query, records, { threshold: 0.5, topK: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("wiki/active.md");
  });
});
