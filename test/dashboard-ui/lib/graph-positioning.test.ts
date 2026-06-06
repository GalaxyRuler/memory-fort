import { describe, expect, test } from "vitest";
import type { GraphEdge, GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";
import {
  computeOrbitalPositions,
  computeTimelineFlowPositions,
  filterByTimelineScrubber,
} from "../../../src/dashboard-ui/lib/graph-positioning.js";

function graphNode(path: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path,
    title: path,
    kind: "wiki",
    type: "projects",
    confidence: 0.9,
    updated: "2026-05-24",
    inboundCount: 0,
    outboundCount: 0,
    ...overrides,
  };
}

function graphEdge(fromPath: string, toPath: string): GraphEdge {
  return {
    fromPath,
    toPath,
    kind: "relation",
    relationType: "uses",
  };
}

describe("graph positioning", () => {
  test("computeOrbitalPositions places focal node at origin and ring nodes by hop distance", () => {
    const nodes = [
      graphNode("wiki/projects/sun.md", { inboundCount: 10 }),
      graphNode("wiki/projects/planet-a.md"),
      graphNode("wiki/projects/planet-b.md"),
      graphNode("wiki/projects/moon.md"),
    ];
    const edges = [
      graphEdge("wiki/projects/sun.md", "wiki/projects/planet-a.md"),
      graphEdge("wiki/projects/sun.md", "wiki/projects/planet-b.md"),
      graphEdge("wiki/projects/planet-a.md", "wiki/projects/moon.md"),
    ];

    const positions = computeOrbitalPositions(nodes, edges);
    const byPath = new Map(positions.map((position) => [position.path, position]));
    const focal = byPath.get("wiki/projects/sun.md");
    const oneHop = [byPath.get("wiki/projects/planet-a.md"), byPath.get("wiki/projects/planet-b.md")];
    const twoHop = byPath.get("wiki/projects/moon.md");

    expect(focal).toMatchObject({ fx: 0, fy: 0, fz: 0 });
    for (const position of oneHop) {
      const radius = Math.hypot(position?.fx ?? 0, position?.fz ?? 0);
      expect(radius).toBeCloseTo(60, 0);
    }
    expect(Math.hypot(twoHop?.fx ?? 0, twoHop?.fz ?? 0)).toBeCloseTo(120, 0);
  });

  test("computeTimelineFlowPositions places older nodes further into negative z", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    const nodes = [
      graphNode("wiki/projects/today.md", { updated: "2026-05-24" }),
      graphNode("wiki/projects/ten-days.md", { updated: "2026-05-14" }),
      graphNode("wiki/projects/hundred-days.md", { updated: "2026-02-13" }),
    ];

    const positions = computeTimelineFlowPositions(nodes, now);
    const byPath = new Map(positions.map((position) => [position.path, position]));
    const today = Math.abs(byPath.get("wiki/projects/today.md")?.fz ?? 0);
    const tenDays = Math.abs(byPath.get("wiki/projects/ten-days.md")?.fz ?? 0);
    const hundredDays = Math.abs(byPath.get("wiki/projects/hundred-days.md")?.fz ?? 0);

    expect(today).toBeLessThan(tenDays);
    expect(hundredDays).toBeGreaterThan(tenDays);
  });

  test("filterByTimelineScrubber includes only nodes within maxAgeDays", () => {
    const now = new Date("2026-05-24T00:00:00.000Z");
    const nodes = [
      graphNode("wiki/projects/today.md", { updated: "2026-05-24" }),
      graphNode("wiki/projects/ten-days.md", { updated: "2026-05-14" }),
      graphNode("wiki/projects/hundred-days.md", { updated: "2026-02-13" }),
    ];

    const visible = filterByTimelineScrubber(nodes, 30, now);

    expect(visible.has("wiki/projects/today.md")).toBe(true);
    expect(visible.has("wiki/projects/ten-days.md")).toBe(true);
    expect(visible.has("wiki/projects/hundred-days.md")).toBe(false);
  });
});
