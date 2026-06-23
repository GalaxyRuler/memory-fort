import { describe, it, expect } from "vitest";
import { normalizeSearchResult } from "../../src/dashboard-ui/hooks/useSearch.js";

describe("normalizeSearchResult provenance fields", () => {
  it("carries the new provenance fields through", () => {
    const [r] = normalizeSearchResult({
      path: "wiki/projects/famtree.md",
      kind: "wiki",
      source: "bm25",
      provenance: {
        path: "wiki/projects/famtree.md",
        kind: "wiki",
        dominantSource: "bm25",
        signals: [{ source: "bm25", rank: 1 }],
        confidence: 0.7,
        sourceFactCount: 1,
        derivedFromCount: 1,
        tier: "low",
      },
    });
    expect(r.provenance.tier).toBe("low");
    expect(r.provenance.confidence).toBe(0.7);
    expect(r.provenance.sourceFactCount).toBe(1);
    expect(r.provenance.derivedFromCount).toBe(1);
  });

  it("defaults invalid provenance fields safely", () => {
    const [r] = normalizeSearchResult({
      path: "wiki/x.md",
      kind: "wiki",
      source: "bm25",
      provenance: { tier: "critical", confidence: 2, sourceFactCount: -1, derivedFromCount: 1.5 },
    });
    expect(r.provenance.tier).toBe("medium");
    expect(r.provenance.confidence).toBeNull();
    expect(r.provenance.sourceFactCount).toBe(0);
    expect(r.provenance.derivedFromCount).toBe(0);
  });
});
