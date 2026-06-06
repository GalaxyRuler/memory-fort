import { describe, expect, it } from "vitest";
import { hitAtK, recallAtK } from "../../src/eval/longmemeval/scoring.js";

describe("LongMemEval scoring", () => {
  it("hitAtK returns true when any expected path appears in the top K", () => {
    expect(hitAtK(["wiki/a.md"], ["wiki/b.md", "wiki/a.md"], 2)).toBe(true);
    expect(hitAtK(["wiki/a.md"], ["wiki/b.md", "wiki/a.md"], 1)).toBe(false);
  });

  it("recallAtK returns zero for empty question sets", () => {
    expect(recallAtK([], 5)).toBe(0);
  });

  it("recallAtK averages per-question hits", () => {
    expect(recallAtK([
      { expected: ["a"], retrieved: ["a"] },
      { expected: ["b"], retrieved: ["x", "b"] },
      { expected: ["c"], retrieved: ["x", "y"] },
    ], 2)).toBe(2 / 3);
  });

  it("normalizes path separators before comparing evidence ids", () => {
    expect(hitAtK(["wiki/decisions/a.md"], ["wiki\\decisions\\a.md"], 1)).toBe(true);
  });
});
