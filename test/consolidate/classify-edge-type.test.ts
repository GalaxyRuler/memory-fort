import { describe, expect, it } from "vitest";
import { classifyEdgeType } from "../../src/consolidate/classify-edge-type.js";
import type { ProposedRelation } from "../../src/consolidate/runner.js";

describe("classifyEdgeType", () => {
  it("classifies tool targets as uses", () => {
    expect(classifyEdgeType(relation({ relPath: "wiki/tools/vitest.md" }))).toBe("uses");
  });

  it("classifies crystal targets as derived_from", () => {
    expect(classifyEdgeType(relation({ relPath: "wiki/crystals/validation-is-key.md" }))).toBe("derived_from");
  });

  it("classifies deprecated or superseded titles as supersedes", () => {
    expect(classifyEdgeType(relation({ title: "Deprecated dashboard port" }))).toBe("supersedes");
    expect(classifyEdgeType(relation({ title: "superseded-by new route" }))).toBe("supersedes");
  });

  it("classifies all BM25-only decision and lesson matches as derived_from", () => {
    expect(classifyEdgeType(relation({
      relPath: "wiki/decisions/embedding-provider.md",
      confidence: 0.65,
      source: "bm25",
    }))).toBe("derived_from");
    expect(classifyEdgeType(relation({
      relPath: "wiki/lessons/runner-timeouts.md",
      confidence: 0.95,
      source: "bm25",
    }))).toBe("derived_from");
    expect(classifyEdgeType(relation({
      relPath: "wiki/decisions/embedding-provider.md",
      confidence: 0.85,
      source: "bm25",
    }))).toBe("derived_from");
  });

  it("leaves lexical and combined decision matches as mentions", () => {
    expect(classifyEdgeType(relation({
      relPath: "wiki/decisions/embedding-provider.md",
      confidence: 0.65,
      source: "lexical",
    }))).toBe("mentions");
    expect(classifyEdgeType(relation({
      relPath: "wiki/decisions/embedding-provider.md",
      confidence: 0.65,
      source: "both",
    }))).toBe("mentions");
  });

  it("falls back to mentions", () => {
    expect(classifyEdgeType(relation({ relPath: "wiki/projects/memory-fort.md" }))).toBe("mentions");
  });
});

function relation(overrides: Partial<ProposedRelation> = {}): ProposedRelation {
  return {
    relPath: "wiki/projects/memory-fort.md",
    title: "Memory Fort",
    confidence: 1,
    source: "lexical",
    ...overrides,
  };
}
