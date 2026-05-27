import { describe, expect, it } from "vitest";
import {
  factorForStatusAndLifecycle,
  scoreByMetadata,
} from "../../src/retrieval/metadata-score.js";
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
      0.08800000000000002,
      0,
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

  it("factorForStatusAndLifecycle composes lifecycle multipliers", () => {
    const factors = defaultLifecycleFactors();
    expect(factorForStatusAndLifecycle("active", "canonical", "unvalidated", factors)).toBe(1);
    expect(factorForStatusAndLifecycle("active", "consolidated", "unvalidated", factors)).toBe(0.9);
    expect(factorForStatusAndLifecycle("active", "proposed", "unvalidated", factors)).toBe(0.7);
    expect(factorForStatusAndLifecycle("active", "observed", "unvalidated", factors)).toBe(0.85);
    expect(factorForStatusAndLifecycle("active", "linked", "unvalidated", factors)).toBe(0.85);
    expect(factorForStatusAndLifecycle("active", "stale", "unvalidated", factors)).toBe(0.5);
    expect(factorForStatusAndLifecycle("active", "disputed", "unvalidated", factors)).toBe(0.3);
    expect(factorForStatusAndLifecycle("active", "dormant", "unvalidated", factors)).toBe(0.4);
    expect(factorForStatusAndLifecycle("active", "archived", "unvalidated", factors)).toBe(0);
  });

  it("factorForStatusAndLifecycle composes validation multipliers", () => {
    const factors = defaultLifecycleFactors();
    expect(factorForStatusAndLifecycle("active", "canonical", "user", factors)).toBe(1.2);
    expect(factorForStatusAndLifecycle("active", "canonical", "auto", factors)).toBe(1.05);
    expect(factorForStatusAndLifecycle("active", "canonical", "challenged", factors)).toBe(0.4);
    expect(factorForStatusAndLifecycle("active", "canonical", "revoked", factors)).toBe(0);
  });

  it("scoreByMetadata deboosts explicit lifecycle but not legacy missing lifecycle", () => {
    const scored = scoreByMetadata(
      [
        doc("wiki/projects/legacy.md", { confidence: 0.8 }),
        doc("wiki/projects/proposed.md", {
          confidence: 0.8,
          lifecycle: "proposed",
        } as Partial<SearchDocument>),
      ],
      {
        now: new Date("2026-05-23T00:00:00.000Z"),
        recencyBoost: 0,
      },
    );

    expect(scored.find((item) => item.path.endsWith("legacy.md"))!.score).toBe(0.8);
    expect(scored.find((item) => item.path.endsWith("proposed.md"))!.score).toBeCloseTo(0.56);
  });

  it("scoreByMetadata boosts user validation while capping final score at one", () => {
    const scored = scoreByMetadata(
      [
        doc("wiki/projects/user.md", {
          confidence: null,
          confidenceFull: { extraction: 0.9, validation: "user" },
          lifecycle: "canonical",
        } as Partial<SearchDocument>),
      ],
      {
        now: new Date("2026-05-23T00:00:00.000Z"),
        recencyBoost: 0,
      },
    );

    expect(scored[0]!.components.statusFactor).toBe(1.2);
    expect(scored[0]!.score).toBe(1);
  });
});

function defaultLifecycleFactors() {
  return {
    activeFactor: 1,
    archivedFactor: 0,
    supersededFactor: 0.1,
    canonicalFactor: 1,
    consolidatedFactor: 0.9,
    proposedFactor: 0.7,
    observedFactor: 0.85,
    linkedFactor: 0.85,
    staleFactor: 0.5,
    disputedFactor: 0.3,
    dormantFactor: 0.4,
    userValidationFactor: 1.2,
    autoValidationFactor: 1.05,
    challengedValidationFactor: 0.4,
    revokedValidationFactor: 0,
  };
}
