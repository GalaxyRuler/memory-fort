import { describe, expect, it } from "vitest";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";
import { matchGraphNodes } from "../../../src/dashboard-ui/lib/graph-search.js";

function node(path: string, title: string): GraphNode {
  return {
    path,
    title,
    kind: "wiki",
    type: "projects",
    confidence: null,
    updated: null,
    inboundCount: 0,
    outboundCount: 0,
  };
}

describe("graph-search", () => {
  it("matchGraphNodes is case-insensitive, matches title and path, and returns an empty set for empty input", () => {
    const nodes = [
      node("wiki/projects/memory-system.md", "Memory System"),
      node("wiki/references/vector-search.md", "Retrieval Notes"),
      node("wiki/tools/cli.md", "Command Line"),
    ];

    expect(matchGraphNodes(nodes, "memory")).toEqual(new Set(["wiki/projects/memory-system.md"]));
    expect(matchGraphNodes(nodes, "VECTOR")).toEqual(new Set(["wiki/references/vector-search.md"]));
    expect(matchGraphNodes(nodes, "   ")).toEqual(new Set());
  });
});
