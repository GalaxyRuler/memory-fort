import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { GraphDetailPanel } from "../../../src/dashboard-ui/components/GraphDetailPanel.js";
import { GraphHUD } from "../../../src/dashboard-ui/components/GraphHUD.js";
import { GraphTelemetry } from "../../../src/dashboard-ui/components/GraphTelemetry.js";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    params,
    to,
  }: {
    children: ReactNode;
    className?: string;
    params?: Record<string, string>;
    to: string;
  }) => {
    const href = params ? to.replace("$category", params.category ?? "").replace("$slug", params.slug ?? "") : to;
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  },
}));

function graphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path: "wiki/projects/memory-system.md",
    title: "memory-system",
    kind: "wiki",
    type: "projects",
    confidence: 0.9,
    updated: "2026-05-24",
    inboundCount: 8,
    outboundCount: 5,
    ...overrides,
  };
}

describe("graph UI components", () => {
  test("GraphHUD renders all three mode buttons and highlights active mode", () => {
    render(<GraphHUD enabledTypes={new Set(["projects"])} mode="force" onModeChange={vi.fn()} onToggleType={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Force/ })).toHaveClass("bg-surface-2");
    expect(screen.getByRole("button", { name: /Clustered/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Constellation/ })).toBeInTheDocument();
  });

  test("GraphHUD fires onModeChange when clicked", () => {
    const onModeChange = vi.fn();
    render(<GraphHUD enabledTypes={new Set(["projects"])} mode="force" onModeChange={onModeChange} onToggleType={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Clustered/ }));

    expect(onModeChange).toHaveBeenCalledWith("clustered");
  });

  test("GraphHUD entity filter toggles", () => {
    const onToggleType = vi.fn();
    render(<GraphHUD enabledTypes={new Set(["projects"])} mode="force" onModeChange={vi.fn()} onToggleType={onToggleType} />);

    fireEvent.click(screen.getByLabelText("projects"));

    expect(onToggleType).toHaveBeenCalledWith("projects");
  });

  test("GraphDetailPanel renders node information and close button", () => {
    render(<GraphDetailPanel node={graphNode()} onClose={vi.fn()} />);

    expect(screen.getByText("memory-system")).toBeInTheDocument();
    expect(screen.getByText("wiki/projects/memory-system.md")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close detail panel" })).toBeInTheDocument();
  });

  test("GraphDetailPanel close fires onClose", () => {
    const onClose = vi.fn();
    render(<GraphDetailPanel node={graphNode()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Close detail panel" }));

    expect(onClose).toHaveBeenCalled();
  });

  test("GraphTelemetry shows counts, mode, and unresolved warning", () => {
    const { container } = render(<GraphTelemetry edgeCount={89} mode="force" nodeCount={47} unresolvedCount={3} />);

    expect(screen.getByText("47")).toBeInTheDocument();
    expect(screen.getByText("89")).toBeInTheDocument();
    expect(screen.getByText("force")).toBeInTheDocument();
    expect(screen.getByText("3 unresolved")).toHaveClass("text-status-amber");
    expect(container).toHaveTextContent("nodes");
    expect(container).toHaveTextContent("edges");
  });
});
