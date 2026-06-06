import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Inspector } from "../../../src/dashboard-ui/components/galactic/Inspector.js";
import type { GraphEdge, GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: "wiki/projects/memory-system.md",
    title: "Memory System",
    kind: "wiki",
    type: "projects",
    cognitiveType: "core",
    confidence: 0.9,
    created: "2026-05-01",
    updated: "2026-05-24",
    status: "active",
    source: "manual",
    tags: ["memory", "graph"],
    inboundCount: 2,
    outboundCount: 1,
    ...overrides,
  };
}

describe("Galactic inspector", () => {
  it("renders selected node metadata, split relations, physics readout, and open callback", () => {
    const nodes = [
      node(),
      node({ path: "wiki/tools/voyage.md", title: "Voyage", type: "tools", cognitiveType: "procedural" }),
      node({ path: "wiki/references/wiki.md", title: "Wiki", type: "references", cognitiveType: "semantic" }),
    ];
    const edges: GraphEdge[] = [
      { fromPath: "wiki/projects/memory-system.md", toPath: "wiki/tools/voyage.md", kind: "relation", relationType: "uses" },
      { fromPath: "wiki/references/wiki.md", toPath: "wiki/projects/memory-system.md", kind: "wikilink", relationType: null },
    ];
    const onOpenMemory = vi.fn();

    render(<Inspector edges={edges} node={nodes[0]!} nodes={nodes} onOpenMemory={onOpenMemory} onSelectNode={vi.fn()} />);

    expect(screen.getByText("Memory System")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("confidence 90%")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("2026-05-01")).toBeInTheDocument();
    expect(screen.getByText("2026-05-24")).toBeInTheDocument();
    expect(screen.getByText("wiki/projects/memory-system.md")).toBeInTheDocument();
    expect(screen.getByText("#memory")).toBeInTheDocument();
    expect(screen.getByText("#graph")).toBeInTheDocument();
    expect(screen.getByText(/References →/)).toBeInTheDocument();
    expect(screen.getByText(/← Referenced by/)).toBeInTheDocument();
    expect(screen.getByText("Voyage")).toBeInTheDocument();
    expect(screen.getByText("Wiki")).toBeInTheDocument();
    expect(screen.getByText(/0\.13/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open Memory/ }));

    expect(onOpenMemory).toHaveBeenCalledWith("wiki/projects/memory-system.md");
  });
});
