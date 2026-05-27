import { describe, expect, it } from "vitest";
import { scoreByMetadata } from "../../src/retrieval/metadata-score.js";
import type { SearchDocument } from "../../src/retrieval/corpus.js";

function doc(
  relPath: string,
  overrides: Partial<SearchDocument> = {},
): SearchDocument {
  const updated = overrides.updated ?? "2026-05-20";
  return {
    kind: "wiki",
    relPath,
    fullPath: `C:/vault/${relPath}`,
    title: relPath,
    type: "projects",
    status: "active",
    confidence: 0.8,
    tags: [],
    relations: {},
    source: "unknown",
    session: null,
    body: "",
    snippetSource: "",
    mtime: updated,
    sizeBytes: 0,
    updated,
    ...overrides,
  };
}

describe("retrieval metadata scoring", () => {
  it("scoreByMetadata ranks active > superseded > archived", () => {
    const scored = scoreByMetadata(
      [
        doc("wiki/projects/archived.md", { status: "archived" }),
        doc("wiki/projects/active.md", { status: "active" }),
        doc("wiki/projects/superseded.md", { status: "superseded" }),
      ],
      { now: new Date("2026-05-23T00:00:00.000Z") },
    );

    expect(scored.map((item) => item.path)).toEqual([
      "wiki/projects/active.md",
      "wiki/projects/superseded.md",
      "wiki/projects/archived.md",
    ]);
    expect(scored.map((item) => item.score)).toEqual([
      0.8800000000000001,
      0.44000000000000006,
      0.264,
    ]);
  });

  it("scoreByMetadata weights by confidence", () => {
    const scored = scoreByMetadata(
      [
        doc("wiki/projects/low.md", { confidence: 0.3 }),
        doc("wiki/projects/high.md", { confidence: 0.9 }),
      ],
      { now: new Date("2026-05-23T00:00:00.000Z") },
    );

    expect(scored.map((item) => item.path)).toEqual([
      "wiki/projects/high.md",
      "wiki/projects/low.md",
    ]);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("scoreByMetadata treats vector extraction like equivalent scalar confidence", () => {
    const scalar = scoreByMetadata(
      [doc("wiki/projects/scalar.md", { confidence: 0.85 })],
      { now: new Date("2026-05-23T00:00:00.000Z") },
    );
    const vector = scoreByMetadata(
      [
        doc("wiki/projects/vector.md", {
          confidence: null,
          confidenceFull: { extraction: 0.85 },
        } as Partial<SearchDocument>),
      ],
      { now: new Date("2026-05-23T00:00:00.000Z") },
    );

    expect(vector[0]!.components.confidenceFactor).toBe(
      scalar[0]!.components.confidenceFactor,
    );
    expect(vector[0]!.score).toBe(scalar[0]!.score);
  });

  it("scoreByMetadata applies recency boost", () => {
    const scored = scoreByMetadata(
      [
        doc("wiki/projects/old.md", {
          updated: "2026-02-12",
          mtime: "2026-05-22T00:00:00.000Z",
        }),
        doc("wiki/projects/recent.md", {
          updated: "2026-05-18",
          mtime: "2026-02-12T00:00:00.000Z",
        }),
      ],
      { now: new Date("2026-05-23T00:00:00.000Z") },
    );

    expect(scored[0]!.path).toBe("wiki/projects/recent.md");
    expect(scored[0]!.components.recencyFactor).toBe(1.1);
    expect(scored[1]!.components.recencyFactor).toBe(1);
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it("scoreByMetadata uses defaultConfidence when frontmatter.confidence is null", () => {
    const scored = scoreByMetadata(
      [doc("wiki/projects/no-confidence.md", { confidence: null })],
      {
        now: new Date("2026-05-23T00:00:00.000Z"),
        defaultConfidence: 0.5,
      },
    );

    expect(scored[0]!.components.confidenceFactor).toBe(0.5);
  });
});
