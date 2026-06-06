import { describe, expect, it } from "vitest";
import { edgeClass, isReasoningEdge } from "../../src/retrieval/edge-classes.js";

describe("edge classification", () => {
  it("classifies tested-with as a reasoning edge", () => {
    const edge = { relationType: "tested-with" };

    expect(edgeClass(edge)).toBe("reasoning");
    expect(isReasoningEdge(edge)).toBe(true);
  });
});
