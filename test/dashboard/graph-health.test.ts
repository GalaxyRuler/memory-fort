import { describe, expect, it } from "vitest";
import type { GraphFeed } from "../../src/dashboard/loaders.js";
import {
  computeGraphHealth,
  type GraphHealthInput,
  metricAgentAttribution,
  metricConfidenceCoverage,
  metricContradictionCoverage,
  metricCrossGalaxyRatio,
  metricDuplicateEntities,
  metricAssociationEdgeCoverage,
  metricEdgeTypeEntropy,
  metricHubOverload,
  metricNarrativeThreadCoverage,
  metricOrphanEpisodic,
  metricGraphParticipationRate,
  metricProjectSubgraphDensity,
  metricProvenanceEdgeCoverage,
  metricProvenanceCoverage,
  metricSalientEpisodeAnchorRate,
  metricTemporalCoverage,
} from "../../src/dashboard/graph-health.js";

describe("graph health metrics", () => {
  it("handles an empty feed without throwing", () => {
    const input = graphInput();

    expect(() => computeGraphHealth(input)).not.toThrow();
    expect(computeGraphHealth(input).metrics).toHaveLength(16);
    expect(metricProvenanceCoverage(input).status).toBe("pass");
    expect(metricProvenanceEdgeCoverage(input.feed).status).toBe("pass");
    expect(metricAssociationEdgeCoverage(input.feed).status).toBe("pass");
    expect(metricConfidenceCoverage(input).status).toBe("pass");
    expect(metricAgentAttribution(input).status).toBe("pass");
  });

  it("aggregates overall status from the worst non-n/a metric", () => {
    const report = computeGraphHealth(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("raw/old.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-01" }),
            node("raw/new.md", { kind: "raw", cognitiveType: "episodic", created: "2026-01-02" }),
            node("wiki/projects/a.md", { kind: "wiki", title: "A", source: "codex", confidence: 0.8 }),
          ],
        }),
        wikiPages: [wikiPage("wiki/projects/a.md", { source: "codex", confidence: 0.8 })],
      }),
    );

    expect(report.overallStatus).toBe("fail");
    expect(report.metrics.find((metric) => metric.id === "graph.narrative-thread-coverage")?.status).toBe("n/a");
  });

  it("keeps all-raw orphan episodic rate informational", () => {
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

    expect(result.status).toBe("pass");
    expect(result.value).toBeCloseTo(66.67, 2);
    expect(result.threshold.rule).toContain("informational");
    expect(result.topOffenders.map((offender) => offender.path)).toEqual(["raw/old.md", "raw/new.md"]);
  });

  it("fails salient recent episode anchor rate when important recent raw observations lack semantic anchors", () => {
    const input = graphInput({
      now: "2026-06-03T00:00:00.000Z",
      feed: graphFeed({
        nodes: [
          node("raw/2026-06-01-salient-linked.md", {
            kind: "raw",
            created: "2026-06-01",
            importance: 8,
          }),
          node("raw/2026-06-02-salient-orphan.md", {
            kind: "raw",
            created: "2026-06-02",
            importance: 7,
          }),
          node("raw/2026-06-02-low-importance.md", {
            kind: "raw",
            created: "2026-06-02",
            importance: 2,
          }),
          node("wiki/projects/a.md", { kind: "wiki" }),
        ],
        edges: [
          edge("raw/2026-06-01-salient-linked.md", "wiki/projects/a.md", {
            type: "mentions",
            relationType: "mentions",
          }),
          edge("raw/2026-06-02-low-importance.md", "wiki/projects/a.md", {
            type: "mentions",
            relationType: "mentions",
          }),
        ],
      }),
    });

    const result = metricSalientEpisodeAnchorRate(input);

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
    expect(result.detail).toContain("1/2 salient recent raw observations have semantic anchors");
  });

  it("finds duplicate entities by normalized and near-match titles", () => {
    const result = metricDuplicateEntities(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("wiki/projects/memory-fort.md", { title: "Memory Fort" }),
            node("raw/memory-fort.md", { kind: "raw", title: "Memory Fort" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/projects/memory-fort.md", { title: "Memory Fort" }),
          wikiPage("wiki/tools/memory-fort-copy.md", { title: "memory fort" }),
          wikiPage("wiki/references/memory-fort-punctuation.md", { title: "Memory-Fort" }),
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

  it("excludes wiki dot-directory operational logs from duplicate entity metrics", () => {
    const result = metricDuplicateEntities(
      graphInput({
        wikiPages: [
          wikiPage("wiki/.audit/procedure-propose-1.md", { title: "procedure propose audit" }),
          wikiPage("wiki/.audit/procedure-propose-2.md", { title: "procedure propose audit" }),
          wikiPage("wiki/.scratch/procedure-propose-3.md", { title: "procedure propose audit" }),
          wikiPage("wiki/projects/procedure-propose-audit.md", { title: "procedure propose audit" }),
        ],
      }),
    );

    expect(result.value).toBe(0);
    expect(result.topOffenders).toEqual([]);
  });

  it("computes edge type entropy over reasoning edges only", () => {
    const result = metricEdgeTypeEntropy(
      graphFeed({
        nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
        edges: [
          ...Array.from({ length: 50 }, (_, index) =>
            edge(`wiki/projects/a.md`, "wiki/tools/b.md", {
              type: "mentioned_in",
              relationType: "mentioned_in",
              validFrom: `2026-01-${String(index + 1).padStart(2, "0")}`,
            }),
          ),
          ...Array.from({ length: 50 }, () =>
            edge("wiki/projects/a.md", "wiki/tools/b.md", {
              kind: "wikilink",
              type: "linked",
              relationType: null,
            }),
          ),
          edge("wiki/tools/b.md", "wiki/projects/a.md", { type: "uses", relationType: "uses", validFrom: "2026-01-10" }),
          edge("wiki/projects/a.md", "wiki/tools/b.md", { type: "depends_on", relationType: "depends_on", validFrom: "2026-01-11" }),
        ],
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.value).toBeCloseTo(1, 2);
    expect(result.detail).toContain("2 reasoning edges");
    expect(result.topOffenders.map((offender) => offender.note)).toEqual(["depends_on", "uses"]);
  });

  it("uses recalibrated cross-galaxy thresholds and reports direction breakdown", () => {
    const result = metricCrossGalaxyRatio(
      graphFeed({
        nodes: [
          node("raw/episode-1.md", { kind: "raw", cognitiveType: "episodic" }),
          node("raw/episode-2.md", { kind: "raw", cognitiveType: "episodic" }),
          node("raw/episode-3.md", { kind: "raw", cognitiveType: "episodic" }),
          node("wiki/projects/a.md", { cognitiveType: "core" }),
          node("wiki/tools/b.md", { cognitiveType: "semantic" }),
          node("wiki/lessons/c.md", { cognitiveType: "core" }),
        ],
        edges: [
          ...Array.from({ length: 96 }, () => edge("raw/episode-1.md", "wiki/tools/b.md")),
          edge("raw/episode-2.md", "wiki/tools/b.md"),
          edge("wiki/tools/b.md", "wiki/projects/a.md"),
          edge("wiki/lessons/c.md", "wiki/tools/b.md"),
          edge("wiki/projects/a.md", "wiki/lessons/c.md"),
        ],
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.value).toBe(99);
    expect(result.threshold).toEqual({ warn: 99, fail: 99.5, rule: "warn > 99%, fail > 99.5%" });
    expect(result.detail).toContain("top crossings: episodic→semantic 97");
    expect(result.detail).toContain("semantic→core 1");
  });

  it.each([
    [99, "pass"],
    [99.2, "warn"],
    [99.6, "fail"],
  ] as const)("classifies cross-galaxy ratio %f as %s", (ratio, status) => {
    const total = 500;
    const crossCount = Math.round((ratio / 100) * total);
    const sameCount = total - crossCount;
    const result = metricCrossGalaxyRatio(
      graphFeed({
        nodes: [
          node("raw/episode.md", { kind: "raw", cognitiveType: "episodic" }),
          node("wiki/tools/b.md", { cognitiveType: "semantic" }),
          node("wiki/tools/c.md", { cognitiveType: "semantic" }),
        ],
        edges: [
          ...Array.from({ length: crossCount }, () => edge("raw/episode.md", "wiki/tools/b.md")),
          ...Array.from({ length: sameCount }, () => edge("wiki/tools/b.md", "wiki/tools/c.md")),
        ],
      }),
    );

    expect(result.value).toBe(ratio);
    expect(result.status).toBe(status);
  });

  it("exempts project hubs from the hub-overload value while surfacing them as offenders", () => {
    const result = metricHubOverload(
      graphFeed({
        nodes: [
          node("wiki/projects/agentmemory.md", { inboundCount: 1016, outboundCount: 0 }),
          node("wiki/lessons/mcp-plugin.md", { inboundCount: 157, outboundCount: 0 }),
        ],
        edges: [
          ...Array.from({ length: 1016 }, (_, index) =>
            edge(`wiki/references/project-source-${index}.md`, "wiki/projects/agentmemory.md", {
              type: "uses",
              relationType: "uses",
            }),
          ),
          ...Array.from({ length: 157 }, (_, index) =>
            edge(`wiki/references/lesson-source-${index}.md`, "wiki/lessons/mcp-plugin.md", {
              type: "depends_on",
              relationType: "depends_on",
            }),
          ),
        ],
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.value).toBe(157);
    expect(result.threshold).toEqual({ warn: 200, fail: 650, rule: "warn > 200 edges, fail > 650 edges" });
    expect(result.detail).toBe("highest non-exempt single-node degree is 157");
    expect(result.topOffenders[0]).toMatchObject({
      path: "wiki/projects/agentmemory.md",
      value: 1016,
      note: "exempt (project hub - by-design anchor); 1016 inbound, 0 outbound",
      exempt: true,
      reason: "project hub - by-design anchor",
    });
  });

  it.each([
    [199, "pass"],
    [250, "warn"],
    [700, "fail"],
  ] as const)("classifies non-exempt hub degree %i as %s", (degree, status) => {
    const result = metricHubOverload(
      graphFeed({
        nodes: [
          node("wiki/lessons/hub.md", { inboundCount: degree, outboundCount: 0 }),
        ],
        edges: Array.from({ length: degree }, (_, index) =>
          edge(`wiki/references/source-${index}.md`, "wiki/lessons/hub.md", {
            type: "uses",
            relationType: "uses",
          }),
        ),
      }),
    );

    expect(result.status).toBe(status);
    expect(result.value).toBe(degree);
  });

  it("passes with value 0 when every node is exempt or the feed is empty", () => {
    const allExempt = metricHubOverload(
      graphFeed({
        nodes: [
          node("wiki/projects/a.md", { inboundCount: 900, outboundCount: 20 }),
          node("wiki/projects/b.md", { inboundCount: 700, outboundCount: 10 }),
        ],
        edges: [
          ...Array.from({ length: 900 }, (_, index) =>
            edge(`wiki/references/a-source-${index}.md`, "wiki/projects/a.md"),
          ),
          ...Array.from({ length: 700 }, (_, index) =>
            edge(`wiki/references/b-source-${index}.md`, "wiki/projects/b.md"),
          ),
        ],
      }),
    );
    const empty = metricHubOverload(graphFeed());

    expect(allExempt.status).toBe("pass");
    expect(allExempt.value).toBe(0);
    expect(empty.status).toBe("pass");
    expect(empty.value).toBe(0);
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
    expect(result.topOffenders[0]?.edge).toEqual({ from: "wiki/tools/b.md", to: "wiki/projects/a.md", type: "uses" });
  });

  it("flags low provenance coverage from existing source metadata", () => {
    const result = metricProvenanceCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("wiki/projects/a.md", { source: "codex" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md", { source: "codex" }),
          wikiPage("wiki/tools/b.md", { source: "unknown" }),
          wikiPage("wiki/lessons/imported.md", { source: "unknown", importedFrom: { system: "agentmemory", originalKey: "lesson" } }),
          wikiPage("wiki/references/c.md", { source: "unknown" }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
    expect(result.detail).toContain("2/4");
  });

  it("flags low confidence coverage across wiki pages", () => {
    const result = metricConfidenceCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("wiki/projects/a.md", { confidence: 0.9 }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md", { confidence: 0.9 }),
          wikiPage("wiki/tools/b.md", { confidence: null, confidenceFull: null }),
          wikiPage("wiki/references/c.md", { confidence: { source: 0.8 } }),
          wikiPage("wiki/lessons/d.md", { confidence: null, confidenceFull: null }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(50);
    expect(result.detail).toContain("2/4");
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
          edge("wiki/projects/dense.md", "wiki/tools/a.md", { type: "uses", relationType: "uses" }),
          edge("wiki/tools/a.md", "wiki/projects/dense.md", { type: "depends_on", relationType: "depends_on" }),
          edge("wiki/projects/dense.md", "wiki/tools/b.md", { type: "uses", relationType: "uses" }),
          edge("wiki/tools/b.md", "wiki/projects/dense.md", { type: "depends_on", relationType: "depends_on" }),
          edge("wiki/projects/sparse.md", "wiki/tools/c.md", { type: "uses", relationType: "uses" }),
          ...Array.from({ length: 50 }, (_, index) => edge("wiki/tools/c.md", `wiki/tools/leaf-${index}.md`, { type: "uses", relationType: "uses" })),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBeCloseTo(0.02, 2);
    expect(result.topOffenders[0]).toMatchObject({ path: "wiki/projects/sparse.md" });
  });

  it("flags low agent attribution from non-empty source fields", () => {
    const result = metricAgentAttribution(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("wiki/projects/a.md", { source: "codex" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md", { source: "codex" }),
          wikiPage("wiki/tools/b.md", { source: "" }),
          wikiPage("wiki/references/c.md", { source: "unknown" }),
          wikiPage("wiki/lessons/d.md", { source: "manual" }),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(50);
    expect(result.detail).toContain("2/4");
  });

  it("fails participation rate when wiki pages are isolated from graph edges", () => {
    const result = metricGraphParticipationRate(
      graphInput({
        feed: graphFeed({
          nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
          edges: [edge("wiki/projects/a.md", "wiki/tools/b.md")],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md"),
          wikiPage("wiki/tools/b.md"),
          ...Array.from({ length: 14 }, (_, index) => wikiPage(`wiki/references/isolated-${index}.md`)),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(12.5);
    expect(result.detail).toBe("2/16 wiki pages participate in at least one reasoning edge (12.5%)");
    expect(result.topOffenders).toHaveLength(5);
    expect(result.topOffenders.every((offender) => offender.path?.includes("isolated"))).toBe(true);
  });

  it("passes participation rate when all wiki pages have an edge", () => {
    const result = metricGraphParticipationRate(
      graphInput({
        feed: graphFeed({
          nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
          edges: [edge("wiki/projects/a.md", "wiki/tools/b.md")],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md"),
          wikiPage("wiki/tools/b.md"),
        ],
      }),
    );

    expect(result.status).toBe("pass");
    expect(result.value).toBe(100);
    expect(result.topOffenders).toEqual([]);
  });

  it("does not count association-only edges as reasoning participation", () => {
    const result = metricGraphParticipationRate(
      graphInput({
        feed: graphFeed({
          nodes: [node("wiki/projects/a.md"), node("wiki/tools/b.md")],
          edges: [
            edge("wiki/projects/a.md", "wiki/tools/b.md", {
              type: "linked",
              relationType: "linked",
            }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/projects/a.md"),
          wikiPage("wiki/tools/b.md"),
        ],
      }),
    );

    expect(result.status).toBe("fail");
    expect(result.value).toBe(0);
    expect(result.detail).toContain("0/2 wiki pages participate in at least one reasoning edge");
  });

  it("returns n/a for narrative thread coverage before threads exist", () => {
    const result = metricNarrativeThreadCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [node("raw/one.md", { kind: "raw" })],
        }),
      }),
    );

    expect(result.status).toBe("n/a");
    expect(result.value).toBeNull();
    expect(result.detail).toBe("no narrative threads in vault yet");
    expect(result.topOffenders).toEqual([]);
  });

  it.each([
    [6, 10, "pass", 60],
    [3, 10, "warn", 30],
    [1, 10, "fail", 10],
  ] as const)(
    "classifies narrative thread coverage %i/%i as %s",
    (referenced, totalRaw, status, expectedValue) => {
      const rawPaths = Array.from({ length: totalRaw }, (_, index) => `raw/episode-${index}.md`);
      const result = metricNarrativeThreadCoverage(
        graphInput({
          feed: graphFeed({
            nodes: rawPaths.map((path) => node(path, { kind: "raw" })),
          }),
          wikiPages: [
            wikiPage("wiki/threads/phase.md", {
              relations: {
                mentions: rawPaths.slice(0, referenced).map((target) => ({ target })),
              },
            }),
          ],
        }),
      );

      expect(result.status).toBe(status);
      expect(result.value).toBe(expectedValue);
      expect(result.detail).toContain(`${referenced}/${totalRaw} raw observations`);
    },
  );

  it("calculates narrative thread coverage over the trailing 30-day raw window", () => {
    const result = metricNarrativeThreadCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("raw/2026-04-01-old-referenced.md", { kind: "raw", created: "2026-04-01" }),
            node("raw/2026-05-03-window-unreferenced.md", { kind: "raw", created: "2026-05-03" }),
            node("raw/2026-05-15-window-unreferenced.md", { kind: "raw", created: "2026-05-15" }),
            node("raw/2026-06-01-window-referenced.md", { kind: "raw", created: "2026-06-01" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/threads/live.md", {
            relations: {
              mentions: [
                { target: "raw/2026-04-01-old-referenced.md" },
                { target: "raw/2026-06-01-window-referenced.md" },
              ],
            },
          }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBeCloseTo(33.33, 2);
    expect(result.detail).toContain("1/3 raw observations referenced by 1 thread");
    expect(result.detail).toContain("trailing 30-day window");
    expect(result.detail).toContain("ending 2026-06-01");
  });

  it("returns n/a for narrative thread coverage when the trailing raw window is empty", () => {
    const result = metricNarrativeThreadCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("raw/unknown-date.md", { kind: "raw", created: null, updated: null }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/threads/live.md", {
            relations: {
              mentions: [
                { target: "raw/unknown-date.md" },
              ],
            },
          }),
        ],
      }),
    );

    expect(result.status).toBe("n/a");
    expect(result.value).toBeNull();
    expect(result.detail).toBe("no raw observations in window");
  });

  it("ignores non-raw targets and archived threads for narrative thread coverage", () => {
    const result = metricNarrativeThreadCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("raw/one.md", { kind: "raw" }),
            node("raw/two.md", { kind: "raw" }),
            node("raw/three.md", { kind: "raw" }),
            node("raw/four.md", { kind: "raw" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/threads/live.md", {
            relations: {
              mentions: [
                { target: "raw/one.md" },
                { target: "wiki/decisions/one.md" },
              ],
            },
          }),
          wikiPage("wiki/archive/threads/old.md", {
            relations: {
              mentions: [
                { target: "raw/two.md" },
                { target: "raw/three.md" },
              ],
            },
          }),
        ],
      }),
    );

    expect(result.status).toBe("warn");
    expect(result.value).toBe(25);
    expect(result.detail).toContain("1/4 raw observations referenced by 1 thread");
  });

  it("excludes proposed thread drafts from narrative thread coverage", () => {
    const result = metricNarrativeThreadCoverage(
      graphInput({
        feed: graphFeed({
          nodes: [
            node("raw/one.md", { kind: "raw" }),
            node("raw/two.md", { kind: "raw" }),
          ],
        }),
        wikiPages: [
          wikiPage("wiki/threads/live.md", {
            relations: { mentions: [{ target: "raw/one.md" }] },
          }),
          wikiPage("wiki/threads-proposed/draft.md", {
            lifecycle: "proposed",
            relations: { mentions: [{ target: "raw/two.md" }] },
          }),
        ],
      }),
    );

    expect(result.value).toBe(50);
    expect(result.detail).toContain("1/2 raw observations referenced by 1 thread");
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

function graphInput(overrides: Partial<GraphHealthInput> = {}): GraphHealthInput {
  return {
    feed: graphFeed(),
    wikiPages: [],
    ...overrides,
  };
}

function wikiPage(
  relPath: string,
  overrides: Partial<GraphHealthInput["wikiPages"][number]> = {},
): GraphHealthInput["wikiPages"][number] {
  return {
    relPath,
    title: relPath.split("/").at(-1)?.replace(/\.md$/, "") ?? relPath,
    source: "unknown",
    confidence: null,
    confidenceFull: null,
    updated: "2026-01-01",
    importedFrom: null,
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
    importance: null,
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
    relationType: "uses",
    type: "uses",
    validFrom: "2026-01-01",
    ...overrides,
  };
}
