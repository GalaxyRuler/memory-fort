import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../../src/dashboard-ui/hooks/useGraph.js";
import { shortestPath, twoHopNeighborhood } from "../../../src/dashboard-ui/lib/graph-pathfind.js";

function edge(fromPath: string, toPath: string): GraphEdge {
  return {
    fromPath,
    toPath,
    kind: "relation",
    relationType: "uses",
  };
}

describe("graph-pathfind", () => {
  it("shortestPath returns null when nodes are disconnected", () => {
    const edges = [edge("a", "b"), edge("c", "d")];

    expect(shortestPath(edges, "a", "d")).toBeNull();
  });

  it("shortestPath returns the expected 3-node path when multiple routes exist", () => {
    const edges = [
      edge("a", "b"),
      edge("b", "d"),
      edge("a", "c"),
      edge("c", "e"),
      edge("e", "d"),
    ];

    expect(shortestPath(edges, "a", "d")).toEqual({
      nodes: ["a", "b", "d"],
      edgePairs: [
        ["a", "b"],
        ["b", "d"],
      ],
    });
  });

  it("twoHopNeighborhood includes 1-hop and 2-hop nodes but excludes 3-hop nodes", () => {
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

    expect(twoHopNeighborhood(edges, "a")).toEqual(new Set(["a", "b", "c"]));
  });
});
