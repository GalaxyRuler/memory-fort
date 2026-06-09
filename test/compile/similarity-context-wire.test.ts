import { describe, it, expect } from "vitest";
import { buildSimilarityAwareContext } from "../../src/compile/similarity-context.js";
import type { EmbeddingRecord } from "../../src/retrieval/embeddings-store.js";

function makeRecord(path: string, vector: number[]): EmbeddingRecord {
  return { path, hash: "h", vector, model: "m", dim: vector.length, ts: "t" };
}

describe("buildSimilarityAwareContext", () => {
  it("returns paths sorted by similarity score", async () => {
    const result = await buildSimilarityAwareContext({
      rawContentVector: [1, 0, 0],
      wikiRecords: [
        makeRecord("wiki/close.md", [0.95, 0.05, 0]),
        makeRecord("wiki/far.md", [0, 0, 1]),
        makeRecord("wiki/medium.md", [0.7, 0.3, 0]),
      ],
      threshold: 0.5,
      topK: 10,
    });

    expect(result[0].path).toBe("wiki/close.md");
    expect(result[1].path).toBe("wiki/medium.md");
    expect(result).toHaveLength(2);
  });
});
