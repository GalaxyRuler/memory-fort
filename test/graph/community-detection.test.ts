import { describe, expect, it } from "vitest";
import { detectCommunities } from "../../src/graph/community-detection.js";

describe("detectCommunities", () => {
  it("clusters connected dense neighborhoods with deterministic labels", () => {
    const clusters = detectCommunities({
      "wiki/projects/memory-system.md": new Set([
        "wiki/tools/vitest.md",
        "wiki/decisions/graph-health.md",
      ]),
      "wiki/tools/vitest.md": new Set([
        "wiki/projects/memory-system.md",
        "wiki/decisions/graph-health.md",
      ]),
      "wiki/decisions/graph-health.md": new Set([
        "wiki/projects/memory-system.md",
        "wiki/tools/vitest.md",
      ]),
      "wiki/projects/iaqar.md": new Set(["wiki/tools/postgres.md"]),
      "wiki/tools/postgres.md": new Set(["wiki/projects/iaqar.md"]),
    }, { minClusterSize: 2 });

    expect(clusters.map((cluster) => cluster.members)).toEqual([
      [
        "wiki/decisions/graph-health.md",
        "wiki/projects/memory-system.md",
        "wiki/tools/vitest.md",
      ],
      [
        "wiki/projects/iaqar.md",
        "wiki/tools/postgres.md",
      ],
    ]);
  });

  it("filters singleton communities and handles empty graphs", () => {
    expect(detectCommunities({
      "wiki/projects/solo.md": new Set(),
      "wiki/projects/pair-a.md": new Set(["wiki/projects/pair-b.md"]),
      "wiki/projects/pair-b.md": new Set(["wiki/projects/pair-a.md"]),
    }, { minClusterSize: 2 }).map((cluster) => cluster.members)).toEqual([
      ["wiki/projects/pair-a.md", "wiki/projects/pair-b.md"],
    ]);
    expect(detectCommunities({}, { minClusterSize: 2 })).toEqual([]);
  });
});
