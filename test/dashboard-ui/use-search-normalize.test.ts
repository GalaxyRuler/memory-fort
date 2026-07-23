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
        chunkId: "wiki/projects/famtree.md#7:0",
        chunkOrdinal: 0,
        byteStart: 12,
        byteEnd: 44,
        sourceContentHash: "a".repeat(64),
        chunkTextHash: "b".repeat(64),
        indexGeneration: 7,
        indexedAt: "2026-07-23T10:00:00.000Z",
        lexicalRank: 1,
        lexicalScore: 3.5,
        vectorRank: null,
        vectorDistance: null,
        appliedScope: "wiki",
        appliedFilters: {
          includeArchived: false,
          asOf: null,
          agentId: null,
          userId: null,
          identityMode: null,
        },
        backend: "index-lexical",
        rankingProfile: "bm25-v1",
      },
    });
    expect(r.provenance).toMatchObject({
      tier: "low",
      confidence: 0.7,
      sourceFactCount: 1,
      derivedFromCount: 1,
      chunkId: "wiki/projects/famtree.md#7:0",
      byteStart: 12,
      byteEnd: 44,
      sourceContentHash: "a".repeat(64),
      chunkTextHash: "b".repeat(64),
      indexGeneration: 7,
      lexicalRank: 1,
      appliedScope: "wiki",
      backend: "index-lexical",
      rankingProfile: "bm25-v1",
    });
  });

  it("preserves unknown provenance facts as null", () => {
    const [r] = normalizeSearchResult({
      path: "wiki/x.md",
      kind: "wiki",
      source: "bm25",
      provenance: { tier: "critical", confidence: 2, sourceFactCount: -1, derivedFromCount: 1.5 },
    });
    expect(r.provenance.tier).toBeNull();
    expect(r.provenance.confidence).toBeNull();
    expect(r.provenance.sourceFactCount).toBeNull();
    expect(r.provenance.derivedFromCount).toBeNull();
  });
});
