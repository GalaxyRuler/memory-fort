import { describe, expect, it } from "vitest";
import { rrfFuse, type RankedList } from "../../src/retrieval/rrf.js";

function list(source: string, relPaths: string[]): RankedList {
  return {
    source,
    items: relPaths.map((relPath, index) => ({ relPath, rank: index + 1 })),
  };
}

describe("RRF fusion", () => {
  it("rrfFuse with empty input returns empty result", () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([{ source: "x", items: [] }])).toEqual([]);
  });

  it("rrfFuse single list preserves order", () => {
    const result = rrfFuse([list("bm25", ["a", "b", "c"])]);

    expect(result.map((item) => item.relPath)).toEqual(["a", "b", "c"]);
    expect(result.map((item) => item.score)).toEqual([
      1 / 61,
      1 / 62,
      1 / 63,
    ]);
  });

  it("rrfFuse fuses two lists correctly", () => {
    const result = rrfFuse([
      list("bm25", ["a", "b", "c"]),
      list("vector", ["c", "a", "d"]),
    ]);

    expect(result.map((item) => item.relPath)).toEqual(["a", "c", "b", "d"]);
    expect(result.find((item) => item.relPath === "a")?.score).toBeCloseTo(
      1 / 61 + 1 / 62,
    );
    expect(result.find((item) => item.relPath === "a")?.sources).toEqual([
      { source: "bm25", rank: 1 },
      { source: "vector", rank: 2 },
    ]);
  });

  it("rrfFuse deterministic tie-break by relPath ascending", () => {
    const result = rrfFuse([
      list("bm25", ["z", "a"]),
      list("vector", ["a", "z"]),
    ]);

    expect(result.map((item) => item.relPath)).toEqual(["a", "z"]);
    expect(result[0]?.score).toBe(result[1]?.score);
  });
});
