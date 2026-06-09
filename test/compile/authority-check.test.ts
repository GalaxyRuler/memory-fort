import { describe, it, expect } from "vitest";
import { classifyDispatch } from "../../src/compile/fact-dispatch.js";

describe("classifyDispatch", () => {
  it("emits dispute_page when similarity + recency criteria met", () => {
    const result = classifyDispatch({
      similarity: 0.92,
      threshold: 0.8,
      existingPageDate: "2025-01-15",
      newSessionDate: "2026-06-09",
      conflictType: "contradiction",
    });
    expect(result.kind).toBe("dispute_page");
  });

  it("emits supersede_page when similarity + recency criteria met", () => {
    const result = classifyDispatch({
      similarity: 0.88,
      threshold: 0.8,
      existingPageDate: "2025-06-01",
      newSessionDate: "2026-06-09",
      conflictType: "supersession",
    });
    expect(result.kind).toBe("supersede_page");
  });

  it("downgrades to rewrite_page when similarity is below threshold", () => {
    const result = classifyDispatch({
      similarity: 0.6,
      threshold: 0.8,
      existingPageDate: "2025-01-15",
      newSessionDate: "2026-06-09",
      conflictType: "contradiction",
    });
    expect(result.kind).toBe("rewrite_page");
  });

  it("downgrades to rewrite_page when new session is not more recent", () => {
    const result = classifyDispatch({
      similarity: 0.95,
      threshold: 0.8,
      existingPageDate: "2026-06-09",
      newSessionDate: "2025-01-15",
      conflictType: "contradiction",
    });
    expect(result.kind).toBe("rewrite_page");
  });

  it("returns noop when conflict type is noop", () => {
    const result = classifyDispatch({
      similarity: 0.99,
      threshold: 0.8,
      existingPageDate: "2025-01-01",
      newSessionDate: "2026-06-09",
      conflictType: "noop",
    });
    expect(result.kind).toBe("noop");
  });
});
