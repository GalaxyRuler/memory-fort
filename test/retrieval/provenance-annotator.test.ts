import { describe, it, expect } from "vitest";
import { buildProvenance } from "../../src/retrieval/provenance-annotator.js";

const baseDoc = (over: Record<string, unknown> = {}) => ({
  relPath: "wiki/projects/famtree.md",
  kind: "wiki" as const,
  confidenceFull: 0.7,
  rawFrontmatter: { source_facts: ["f_0"] },
  relations: { derived_from: [{ target: "raw/2026-06-20/codex-x.md" }] },
  ...over,
});

describe("buildProvenance", () => {
  it("includes cheap frontmatter-derived fields", () => {
    const p = buildProvenance(baseDoc(), "bm25", [{ source: "bm25", rank: 1 }]);
    expect(p.confidence).toBe(0.7);
    expect(p.sourceFactCount).toBe(1);
    expect(p.derivedFromCount).toBe(1);
    expect(p.dominantSource).toBe("bm25");
  });

  it("tiers a thin consolidated page as low", () => {
    const p = buildProvenance(baseDoc({ confidenceFull: 0.7, rawFrontmatter: { source_facts: ["f_0"] } }), "bm25", []);
    expect(p.tier).toBe("low"); // <=1 source fact AND <=1 derived-from on a wiki page
  });

  it("tiers a well-supported page as high", () => {
    const p = buildProvenance(
      baseDoc({ confidenceFull: 0.95, rawFrontmatter: { source_facts: ["f_0", "f_1", "f_2", "f_3"] },
        relations: { derived_from: [{ target: "a" }, { target: "b" }, { target: "c" }] } }),
      "vector", [],
    );
    expect(p.tier).toBe("high");
  });

  it("uses extraction confidence to keep weak well-supported wiki pages low", () => {
    const p = buildProvenance(
      baseDoc({
        confidenceFull: { extraction: 0.3 },
        rawFrontmatter: { source_facts: ["f_0", "f_1", "f_2"] },
        relations: { derived_from: [{ target: "a" }, { target: "b" }] },
      }),
      "vector", [],
    );
    expect(p.confidence).toBe(0.3);
    expect(p.tier).toBe("low");
  });

  it("clamps out-of-range confidence to [0,1] so it matches the MCP surface", () => {
    expect(buildProvenance(baseDoc({ confidenceFull: 1.5 }), "bm25", []).confidence).toBe(1);
    expect(buildProvenance(baseDoc({ confidenceFull: -0.3 }), "bm25", []).confidence).toBe(0);
    expect(buildProvenance(baseDoc({ confidenceFull: { extraction: 2 } }), "bm25", []).confidence).toBe(1);
  });
});
