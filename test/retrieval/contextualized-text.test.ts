import { describe, expect, it } from "vitest";
import type { SearchDocument } from "../../src/retrieval/corpus.js";
import { buildContextBlock } from "../../src/retrieval/contextualized-text.js";

function stubDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    kind: "wiki",
    relPath: "wiki/projects/test.md",
    fullPath: "C:/vault/wiki/projects/test.md",
    title: "Test",
    type: "projects",
    status: "active",
    cognitiveType: "semantic",
    confidence: 0.8,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    importedFrom: null,
    body: "",
    snippetSource: "",
    mtime: "2026-05-20T00:00:00.000Z",
    sizeBytes: 0,
    created: "2026-05-01",
    observedAt: null,
    updated: "2026-05-20",
    ...overrides,
  };
}

describe("buildContextBlock", () => {
  it("includes path, type, cognitive type, and lifecycle", () => {
    const doc = stubDoc({
      relPath: "wiki/projects/alpha.md",
      type: "projects",
      cognitiveType: "core",
      lifecycle: "canonical",
    });
    const result = buildContextBlock(doc, []);
    expect(result).toContain("# wiki/projects/alpha.md");
    expect(result).toContain("Type: projects");
    expect(result).toContain("Cognitive: core");
    expect(result).toContain("Lifecycle: canonical");
  });

  it("sorts relations alphabetically by type then target", () => {
    const doc = stubDoc({
      relations: {
        uses: [{ target: "voyage" }, { target: "codex" }],
        depends_on: [{ target: "zeta" }, { target: "alpha" }],
      },
    });
    const result = buildContextBlock(doc, []);
    // depends_on comes before uses alphabetically
    const depIdx = result.indexOf("depends_on");
    const usesIdx = result.indexOf("uses");
    expect(depIdx).toBeGreaterThanOrEqual(0);
    expect(usesIdx).toBeGreaterThanOrEqual(0);
    expect(depIdx).toBeLessThan(usesIdx);
    // Within uses: codex before voyage
    const codexIdx = result.indexOf("[[codex]]");
    const voyageIdx = result.indexOf("[[voyage]]");
    expect(codexIdx).toBeLessThan(voyageIdx);
    // Within depends_on: alpha before zeta
    const alphaIdx = result.indexOf("[[alpha]]");
    const zetaIdx = result.indexOf("[[zeta]]");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("sorts tags alphabetically", () => {
    const doc = stubDoc({
      tags: ["zebra", "apple", "mango"],
    });
    const result = buildContextBlock(doc, []);
    expect(result).toContain("# Tags: apple, mango, zebra");
  });

  it("includes backlinks with cap at 10", () => {
    const backlinks = Array.from({ length: 15 }, (_, i) => `wiki/page-${String(i).padStart(2, "0")}.md`);
    const doc = stubDoc();
    const result = buildContextBlock(doc, backlinks);
    // 15 backlinks - 10 shown = 5 overflow
    expect(result).toContain("(+5 more)");
    // Only first 10 sorted should appear
    const sorted = [...backlinks].sort();
    for (const bl of sorted.slice(0, 10)) {
      expect(result).toContain(`[[${bl}]]`);
    }
    // The 11th and beyond should not appear as individual links
    for (const bl of sorted.slice(10)) {
      expect(result).not.toContain(`[[${bl}]]`);
    }
  });

  it("omits backlinks line when empty", () => {
    const doc = stubDoc();
    const result = buildContextBlock(doc, []);
    expect(result).not.toContain("Backlinks:");
  });

  it("omits relations line when no relations exist", () => {
    const doc = stubDoc({ relations: {} });
    const result = buildContextBlock(doc, []);
    expect(result).not.toContain("Relations:");
  });

  it("is deterministic: same input produces same output", () => {
    const doc = stubDoc({
      relPath: "wiki/tools/embed.md",
      tags: ["nlp", "vectors", "ai"],
      relations: {
        uses: [{ target: "voyage" }, { target: "codex" }],
        depends_on: [{ target: "config" }],
      },
    });
    const backlinks = ["wiki/b.md", "wiki/a.md"];
    const first = buildContextBlock(doc, backlinks);
    const second = buildContextBlock(doc, backlinks);
    expect(first).toBe(second);
  });

  it("respects 500-character cap", () => {
    // Create a doc with many relations to exceed 500 chars
    const relations: Record<string, Array<{ target: string }>> = {};
    for (let i = 0; i < 20; i++) {
      relations[`rel_type_${String(i).padStart(2, "0")}`] = [
        { target: `target-alpha-${i}` },
        { target: `target-beta-${i}` },
      ];
    }
    const doc = stubDoc({ relations });
    const result = buildContextBlock(doc, []);
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
