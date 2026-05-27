import { describe, expect, it } from "vitest";
import type { GraphFeed } from "../../src/dashboard/loaders.js";
import {
  computeGraphHealth,
  metricAgentAttribution,
  metricConfidenceCoverage,
  metricContradictionCoverage,
  metricCrossGalaxyRatio,
  metricDuplicateEntities,
  metricEdgeTypeEntropy,
  metricHubOverload,
  metricNarrativeThreadCoverage,
  metricOrphanEpisodic,
  metricProjectSubgraphDensity,
  metricProvenanceCoverage,
  metricTemporalCoverage,
} from "../../src/dashboard/graph-health.js";

describe("graph health metrics", () => {
  it("handles an empty feed without throwing", () => {
    const feed = graphFeed();

    expect(() => computeGraphHealth(feed)).not.toThrow();
    expect(computeGraphHealth(feed).metrics).toHaveLength(12);
    expect(metricProvenanceCoverage(feed).status).toBe("pass");
    expect(metricConfidenceCoverage(feed).status).toBe("pass");
    expect(metricAgentAttribution(feed).status).toBe("pass");
  });

  it("aggregates overall status from the worst non-n/a metric", () => {
    const report = computeGraphHealth(
      graphFeed({
        nodes: [
          node("raw/old.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-01" }),
          node("raw/new.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-02" }),
          node("wiki/projects/a.md", { kind: "wiki", title: "A", source: "codex", confidence: 0.8 }),
        ],
      }),
    );

    expect(report.overallStatus).toBe("fail");
    expect(report.metrics.find((metric) => metric.id === "graph.narrative-thread-coverage")?.status).toBe("n/a");
  });

  it("reports orphan episodic raw observations over the fail threshold", () => {
    const result = metricOrphanEpisodic(
      graphFeed({
        nodes: [
          node("raw/old.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-01" }),
          node("raw/new.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-02" }),
          node("raw/linked.md", {
            kind: "raw",
            cognitiveType: "episodic",
            created: "2026-01-03",
            outboundCount: 1,
          }),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBeCloseTo(66.67, 2);
    expect(result.topOffenders.map((offender) => offender.path)).toEqual(["raw/old.md", "raw/new.md"]);
  });

  it("finds duplicate entities by normalized and near-match titles", () => {
    const result = metricDuplicateEntities(
      graphFeed({
        nodes: [
          node("wiki/projects/memory-fort.md", { title: "Memory Fort" }),
          node("wiki/tools/memory-fort-copy.md", { title: "memory fort" }),
          node("wiki/references/memory-fort-punctuation.md", { title: "Memory-Fort" }),
          node("raw/memory-fort.md", { kind: "raw", title: "Memory Fort" }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(3);
    expect(result.topOffenders.map((offender) => offender.pair)).toContainEqual([
      "wiki/projects/memory-fort.md",
      "wiki/tools/memory-fort-copy.md",
    ]);
  });

  it("flags low edge type entropy and reports dominant edge types", () => {
    const result = metricEdgeTypeEntropy(
      graphFeed({
        nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
        edges: [
          ...Array.from({ length: 9 }, (_, index) =>
            edge(`wiki/projects/a.md`, "wiki/tools/b.md", { type: "mentions", validFrom: `2026-01-0${index + 1}` }),
          ),
          edge("wiki/tools/b.md", "wiki/projects/a.md", { type: "supports", validFrom: "2026-01-10" }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBeCloseTo(0.47, 2);
    expect(result.topOffenders[0]).toMatchObject({ value: "90.0%", note: "mentions" });
  });

  it("uses endpoint cognitiveType values for cross-galaxy ratio", () => {
    const result = metricCrossGalaxyRatio(
      graphFeed({
        nodes: [
          node("wiki/projects/a.md", { cognitiveType: "core" }),
          node("wiki/tools/b.md", { cognitiveType: "semantic" }),
          node("wiki/lessons/c.md", { cognitiveType: "core" }),
        ],
        edges: [
          edge("wiki/projects/a.md", "wiki/tools/b.md"),
          edge("wiki/tools/b.md", "wiki/lessons/c.md"),
          edge("wiki/lessons/c.md", "wiki/tools/b.md"),
          edge("wiki/projects/a.md", "wiki/lessons/c.md"),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(75);
  });

  it("flags hub overload by maximum total node degree", () => {
    const result = metricHubOverload(
      graphFeed({
        nodes: [
          node("wiki/projects/hub.md", { inboundCount: 61, outboundCount: 0 }),
          node("wiki/tools/small.md", { inboundCount: 2, outboundCount: 3 }),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(61);
    expect(result.topOffenders[0]).toMatchObject({ path: "wiki/projects/hub.md", value: 61 });
  });

  it("flags low temporal coverage for edges missing validFrom", () => {
    const result = metricTemporalCoverage(
      graphFeed({
        nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
        edges: [
          edge("wiki/projects/a.md", "wiki/tools/b.md", { validFrom: "2026-01-01" }),
          edge("wiki/tools/b.md", "wiki/projects/a.md", { validFrom: undefined }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
    expect(result.topOffenders[0]?.edge).toEqual({ from: "wiki/tools/b.md", to: "wiki/projects/a.md", type: "linked" });
  });

  it("flags low provenance coverage from existing source metadata", () => {
    const result = metricProvenanceCoverage(
      graphFeed({
        nodes: [
          node("wiki/projects/a.md", { source: "codex" }),
          node("wiki/tools/b.md", { source: "unknown" }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
  });

  it("flags low confidence coverage across wiki pages", () => {
    const result = metricConfidenceCoverage(
      graphFeed({
        nodes: [
          node("wiki/projects/a.md", { confidence: 0.9 }),
          node("wiki/tools/b.md", { confidence: null, confidenceFull: null }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
  });

  it("flags contradiction edges over the fail threshold", () => {
    const result = metricContradictionCoverage(
      graphFeed({
        nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
        edges: Array.from({ length: 21 }, (_, index) =>
          edge("wiki/projects/a.md", "wiki/tools/b.md", {
            type: "contradicts",
            relationType: "contradicts",
            validFrom: `2026-01-${String(index + 1).padStart(2, "0")}`,
          }),
        ),
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(21);
    expect(result.topOffenders).toHaveLength(5);
  });

  it("computes the minimum project subgraph density", () => {
    const result = metricProjectSubgraphDensity(
      graphFeed({
        nodes: [
          node("wiki/projects/dense.md", { type: "projects" }),
          node("wiki/projects/sparse.md", { type: "projects" }),
          node("wiki/tools/a.md", { type: "tools" }),
          node("wiki/tools/b.md", { type: "tools" }),
          node("wiki/tools/c.md", { type: "tools" }),
          ...Array.from({ length: 50 }, (_, index) => node(`wiki/tools/leaf-${index}.md`, { type: "tools" })),
        ],
        edges: [
          edge("wiki/projects/dense.md", "wiki/tools/a.md"),
          edge("wiki/tools/a.md", "wiki/projects/dense.md"),
          edge("wiki/projects/dense.md", "wiki/tools/b.md"),
          edge("wiki/tools/b.md", "wiki/projects/dense.md"),
          edge("wiki/projects/sparse.md", "wiki/tools/c.md"),
          ...Array.from({ length: 50 }, (_, index) => edge("wiki/tools/c.md", `wiki/tools/leaf-${index}.md`)),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBeCloseTo(0.02, 2);
    expect(result.topOffenders[0]).toMatchObject({ path: "wiki/projects/sparse.md" });
  });

  it("flags low agent attribution from non-empty source fields", () => {
    const result = metricAgentAttribution(
      graphFeed({
        nodes: [
          node("wiki/projects/a.md", { source: "codex" }),
          node("wiki/tools/b.md", { source: "" }),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(50);
  });

  it("returns the narrative thread coverage Phase 4 stub", () => {
    const result = metricNarrativeThreadCoverage(graphFeed());

    expect(result.status).toBe("n/a");
    expect(result.value).toBeNull();
    expect(result.detail).toBe("pending narrative threads in Phase 4");
    expect(result.topOffenders).toEqual([]);
  });
});

function graphFeed(overrides: Partial<GraphFeed> = {}): GraphFeed {
  return {
    nodes: [],
    edges: [],
    unresolvedTargets: [],
    ...overrides,
  };
}

function node(
  path: string,
  overrides: Partial<GraphFeed["nodes"][number]> = {},
): GraphFeed["nodes"][number] {
  return {
    path,
    title: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    kind: "wiki",
    type: "projects",
    cognitiveType: "semantic",
    status: "active",
    source: "unknown",
    created: "2026-01-01",
    confidence: null,
    confidenceFull: null,
    lifecycle: null,
    tags: [],
    description: "",
    updated: "2026-01-01",
    inboundCount: 0,
    outboundCount: 0,
    ...overrides,
  };
}

function edge(
  fromPath: string,
  toPath: string,
  overrides: Partial<GraphFeed["edges"][number]> = {},
): GraphFeed["edges"][number] {
  return {
    fromPath,
    toPath,
    kind: "relation",
    relationType: "linked",
    type: "linked",
    validFrom: "2026-01-01",
    ...overrides,
  };
}
