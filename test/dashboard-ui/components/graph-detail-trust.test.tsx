import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphDetailPanel } from "../../../src/dashboard-ui/components/GraphDetailPanel.js";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: any) => (
    <a href={`${to}/${params?.category ?? ""}/${params?.slug ?? ""}`} {...rest}>
      {children}
    </a>
  ),
}));

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: "wiki/projects/memory-system.md",
    title: "Memory System",
    kind: "wiki",
    type: "projects",
    cognitiveType: "semantic",
    status: "active",
    source: "manual",
    created: "2026-05-01",
    confidence: 0.9,
    tags: [],
    description: "Memory system.",
    updated: "2026-05-24",
    inboundCount: 4,
    outboundCount: 7,
    ...overrides,
  };
}

describe("GraphDetailPanel trust rendering", () => {
  it("renders scalar confidence as score plus auto-detected lifecycle", () => {
    render(<GraphDetailPanel node={node()} onClose={vi.fn()} />);

    expect(screen.getByText("Trust")).toBeInTheDocument();
    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("0.90")).toBeInTheDocument();
    expect(screen.getByText("CANONICAL")).toBeInTheDocument();
    expect(screen.queryByText("Validation")).not.toBeInTheDocument();
    expect(screen.queryByText("Freshness")).not.toBeInTheDocument();
  });

  it("renders vector confidence fields when present", () => {
    render(
      <GraphDetailPanel
        node={node({
          confidence: 0.85,
          confidenceFull: {
            extraction: 0.85,
            source: 1,
            validation: "user",
            freshness: "2026-05-13",
          },
          lifecycle: "canonical",
        } as Partial<GraphNode>)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Score")).toBeInTheDocument();
    expect(screen.getByText("Validation")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Freshness")).toBeInTheDocument();
    expect(screen.getByText("Lifecycle")).toBeInTheDocument();
    expect(screen.getByText("manual (1.00)")).toBeInTheDocument();
    expect(screen.getByText("USER")).toBeInTheDocument();
  });

  it("applies validation badge color classes", () => {
    render(
      <GraphDetailPanel
        node={node({
          confidenceFull: { extraction: 0.7, validation: "challenged" },
        } as Partial<GraphNode>)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("CHALLENGED")).toHaveClass("text-status-amber");
  });

  it("applies lifecycle badge color classes", () => {
    render(
      <GraphDetailPanel
        node={node({
          confidenceFull: { extraction: 0.7 },
          lifecycle: "disputed",
        } as Partial<GraphNode>)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("DISPUTED")).toHaveClass("text-orange-400");
  });

  it("hides freshness when it is missing", () => {
    render(
      <GraphDetailPanel
        node={node({
          confidenceFull: { extraction: 0.7, validation: "auto" },
        } as Partial<GraphNode>)}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("Freshness")).not.toBeInTheDocument();
    expect(screen.queryByText("unknown")).not.toBeInTheDocument();
  });
});
