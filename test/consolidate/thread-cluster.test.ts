import { describe, expect, it } from "vitest";
import {
  clusterRawObservations,
  type RawObservationRef,
} from "../../src/consolidate/thread-cluster.js";

describe("clusterRawObservations", () => {
  it("clusters observations sharing entities inside the time window", () => {
    const clusters = clusterRawObservations([
      obs("one", "2026-05-01", ["wiki/projects/memory-fort.md", "wiki/tools/vitest.md"]),
      obs("two", "2026-05-02", ["wiki/projects/memory-fort.md", "wiki/tools/vitest.md"]),
      obs("three", "2026-05-03", ["wiki/projects/memory-fort.md", "wiki/tools/vitest.md"]),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.observations.map((item) => item.relPath)).toEqual([
      "raw/2026-05-01/one.md",
      "raw/2026-05-02/two.md",
      "raw/2026-05-03/three.md",
    ]);
    expect(clusters[0]?.sharedEntities).toEqual([
      "wiki/projects/memory-fort.md",
      "wiki/tools/vitest.md",
    ]);
    expect(clusters[0]?.timeRange).toEqual({ start: "2026-05-01", end: "2026-05-03" });
    expect(clusters[0]?.cohesionScore).toBe(1);
  });

  it("does not cluster observations separated by more than the time window", () => {
    const clusters = clusterRawObservations([
      obs("one", "2026-05-01", ["wiki/projects/memory-fort.md"]),
      obs("two", "2026-05-20", ["wiki/projects/memory-fort.md"]),
      obs("three", "2026-06-10", ["wiki/projects/memory-fort.md"]),
    ]);

    expect(clusters).toEqual([]);
  });

  it("filters clusters below the minimum size", () => {
    const clusters = clusterRawObservations([
      obs("one", "2026-05-01", ["wiki/projects/memory-fort.md"]),
      obs("two", "2026-05-02", ["wiki/projects/memory-fort.md"]),
    ]);

    expect(clusters).toEqual([]);
  });

  it("splits mega-clusters at the maximum size", () => {
    const observations = Array.from({ length: 50 }, (_, index) =>
      obs(`item-${index}`, `2026-05-${String((index % 5) + 1).padStart(2, "0")}`, [
        "wiki/projects/memory-fort.md",
        "wiki/tools/vitest.md",
      ])
    );

    const clusters = clusterRawObservations(observations, { maxClusterSize: 30 });

    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.observations.length).sort((a, b) => b - a)).toEqual([30, 20]);
  });

  it("does not cluster singleton observations with no shared entities", () => {
    const clusters = clusterRawObservations([
      obs("one", "2026-05-01", []),
      obs("two", "2026-05-02", ["wiki/projects/other.md"]),
      obs("three", "2026-05-03", []),
    ]);

    expect(clusters).toEqual([]);
  });

  it("scores tighter shared-entity clusters above looser clusters", () => {
    const clusters = clusterRawObservations([
      obs("tight-1", "2026-05-01", ["wiki/a.md", "wiki/b.md", "wiki/c.md"]),
      obs("tight-2", "2026-05-02", ["wiki/a.md", "wiki/b.md", "wiki/c.md"]),
      obs("tight-3", "2026-05-03", ["wiki/a.md", "wiki/b.md", "wiki/c.md"]),
      obs("loose-1", "2026-05-20", ["wiki/x.md", "wiki/y.md"]),
      obs("loose-2", "2026-05-21", ["wiki/x.md", "wiki/z.md"]),
      obs("loose-3", "2026-05-22", ["wiki/x.md", "wiki/q.md"]),
    ], { minJaccard: 0.25 });

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.observations[0]?.relPath).toContain("tight");
    expect(clusters[0]?.cohesionScore).toBeGreaterThan(clusters[1]?.cohesionScore ?? 0);
  });
});

function obs(name: string, created: string, entities: string[]): RawObservationRef {
  return {
    relPath: `raw/${created}/${name}.md`,
    created,
    entities,
    source: "codex",
    title: name,
    snippet: `${name} body`,
  };
}
