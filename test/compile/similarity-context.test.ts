import { describe, it, expect } from "vitest";
import { selectSimilarContext } from "../../src/compile/similarity-context.js";
import type { EmbeddingRecord } from "../../src/retrieval/embeddings-store.js";

function makeRecord(path: string, vector: number[]): EmbeddingRecord {
  return { path, hash: "h", vector, model: "m", dim: vector.length, ts: "t" };
}

describe("selectSimilarContext", () => {
  it("returns wiki page paths whose embeddings are similar to query", async () => {
    const queryVector = [1, 0, 0];
    const records = [
      makeRecord("wiki/related.md", [0.95, 0.05, 0]),
      makeRecord("wiki/unrelated.md", [0, 0, 1]),
      makeRecord("wiki/somewhat.md", [0.7, 0.3, 0]),
    ];

    const result = await selectSimilarContext({
      queryVector,
      embeddingRecords: records,
      threshold: 0.6,
      topK: 5,
    });

    expect(result.map((r) => r.path)).toContain("wiki/related.md");
    expect(result.map((r) => r.path)).toContain("wiki/somewhat.md");
    expect(result.map((r) => r.path)).not.toContain("wiki/unrelated.md");
  });

  it("returns empty when no embeddings above threshold", async () => {
    const result = await selectSimilarContext({
      queryVector: [1, 0, 0],
      embeddingRecords: [makeRecord("wiki/far.md", [0, 0, 1])],
      threshold: 0.8,
      topK: 5,
    });
    expect(result).toEqual([]);
  });

  it("respects topK limit", async () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord(`wiki/page-${i}.md`, [0.9 - i * 0.01, 0.1 + i * 0.01, 0]),
    );
    const result = await selectSimilarContext({
      queryVector: [1, 0, 0],
      embeddingRecords: records,
      threshold: 0.5,
      topK: 3,
    });
    expect(result).toHaveLength(3);
  });
});
