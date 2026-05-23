import { describe, expect, it } from "vitest";
import {
  applyHydeExpansion,
  buildHydePrompt,
  defaultSchemaSummary,
  shouldUseHyde,
} from "../../src/retrieval/hyde.js";

describe("HyDE orchestration helpers", () => {
  it("shouldUseHyde triggers for short query", () => {
    expect(shouldUseHyde({ query: "voyage", bm25HitCount: 10 })).toBe(true);
  });

  it("shouldUseHyde does NOT trigger for long query with hits", () => {
    expect(
      shouldUseHyde({
        query: "voyage embeddings AI memory system Phase 3",
        bm25HitCount: 10,
      }),
    ).toBe(false);
  });

  it("shouldUseHyde triggers for long query with zero BM25 hits", () => {
    expect(
      shouldUseHyde({
        query: "voyage embeddings AI memory system phase three",
        bm25HitCount: 0,
      }),
    ).toBe(true);
  });

  it("buildHydePrompt substitutes both placeholders", () => {
    const result = buildHydePrompt({
      query: "foo",
      schemaSummary: "bar",
      templateContent: "Q={{query}} S={{schema_summary}}",
    });

    expect(result).toBe("Q=foo S=bar");
    expect(result).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("buildHydePrompt uses defaultSchemaSummary when not provided", () => {
    const result = buildHydePrompt({
      query: "foo",
      templateContent: "S={{schema_summary}}",
    });

    expect(result).toContain("projects");
    expect(defaultSchemaSummary()).toContain("decisions");
    expect(defaultSchemaSummary().length).toBeLessThan(200);
  });

  it("applyHydeExpansion returns the expansion text", () => {
    const result = applyHydeExpansion({
      query: "voyage",
      expansion: "Voyage AI is an embedding provider used by memory-system.",
    });

    expect(result.embeddingInput).toBe(
      "Voyage AI is an embedding provider used by memory-system.",
    );
  });
});
