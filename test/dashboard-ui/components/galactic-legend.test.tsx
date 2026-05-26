import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Legend } from "../../../src/dashboard-ui/components/galactic/Legend.js";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

describe("Galactic legend", () => {
  it("renders cognitive galaxies, domain shapes, and physics legend rows", () => {
    render(<Legend nodes={[]} />);

    expect(screen.getByText("Cognitive Galaxies")).toBeInTheDocument();
    expect(screen.getByText("Core")).toBeInTheDocument();
    expect(screen.getByText("Semantic")).toBeInTheDocument();
    expect(screen.getByText("Episodic")).toBeInTheDocument();
    expect(screen.getByText("Procedural")).toBeInTheDocument();
    expect(screen.getByText("Domain Shapes")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Decisions")).toBeInTheDocument();
    expect(screen.getByText("Lessons")).toBeInTheDocument();
    expect(screen.getByText("References")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Crystals")).toBeInTheDocument();
    expect(screen.getByText("orbit pull · inbound count")).toBeInTheDocument();
    expect(screen.getByText("glow halo · confidence")).toBeInTheDocument();
    expect(screen.getByText("edge lens · relation weight")).toBeInTheDocument();
  });

  it("shows reactive node counts for cognitive galaxies and domain shapes including zero rows", () => {
    const { rerender } = render(<Legend nodes={[
      node({ path: "wiki/projects/a.md", type: "projects", cognitiveType: "core" }),
      node({ path: "wiki/projects/b.md", type: "projects", cognitiveType: "semantic" }),
      node({ path: "wiki/references/c.md", type: "references", cognitiveType: "semantic" }),
      node({ path: "crystals/d.md", kind: "crystal", type: "crystal", cognitiveType: "procedural" }),
    ]} />);

    expect(screen.getByLabelText("Core count")).toHaveTextContent("1");
    expect(screen.getByLabelText("Semantic count")).toHaveTextContent("2");
    expect(screen.getByLabelText("Episodic count")).toHaveTextContent("0");
    expect(screen.getByLabelText("Episodic count")).toHaveClass("text-text-ghost");
    expect(screen.getByLabelText("Procedural count")).toHaveTextContent("1");
    expect(screen.getByLabelText("Projects count")).toHaveTextContent("2");
    expect(screen.getByLabelText("References count")).toHaveTextContent("1");
    expect(screen.getByLabelText("Tools count")).toHaveTextContent("0");
    expect(screen.getByLabelText("Crystals count")).toHaveTextContent("1");

    rerender(<Legend nodes={[node({ path: "raw/2026-05-26/session.md", kind: "raw", type: "raw-session", cognitiveType: "episodic" })]} />);

    expect(screen.getByLabelText("Core count")).toHaveTextContent("0");
    expect(screen.getByLabelText("Episodic count")).toHaveTextContent("1");
    expect(screen.getByLabelText("Lessons count")).toHaveTextContent("1");
  });
});

function node(overrides: Partial<GraphNode>): GraphNode {
  return {
    path: "wiki/references/default.md",
    title: "Default",
    kind: "wiki",
    type: "references",
    cognitiveType: "semantic",
    status: "active",
    source: "manual",
    created: "2026-05-26",
    confidence: null,
    tags: [],
    description: "",
    updated: "2026-05-26",
    inboundCount: 0,
    outboundCount: 0,
    ...overrides,
  };
}
