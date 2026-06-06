import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { GraphDetailPanel } from "../../../src/dashboard-ui/components/GraphDetailPanel.js";
import { GraphHUD } from "../../../src/dashboard-ui/components/GraphHUD.js";
import { GraphTelemetry } from "../../../src/dashboard-ui/components/GraphTelemetry.js";
import { TimelineScrubber } from "../../../src/dashboard-ui/components/TimelineScrubber.js";
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
    cognitiveType: "semantic",
    status: "active",
    source: "manual",
    created: "2026-05-20",
    confidence: 0.9,
    tags: [],
    description: "",
    updated: "2026-05-24",
    inboundCount: 8,
    outboundCount: 5,
    ...overrides,
  };
}

function renderGraphHUD(overrides: Partial<Parameters<typeof GraphHUD>[0]> = {}) {
  return render(
    <GraphHUD
      enabledTypes={new Set(["projects"])}
      mode="force"
      searchMatchCount={0}
      searchQuery=""
      onModeChange={vi.fn()}
      onSearchChange={vi.fn()}
      onToggleType={vi.fn()}
      {...overrides}
    />,
  );
}

describe("graph UI components", () => {
  test("GraphHUD renders core mode buttons and highlights active mode", () => {
    renderGraphHUD();

    expect(screen.getByRole("button", { name: /Force/ })).toHaveClass("bg-surface-2");
    expect(screen.getByRole("button", { name: /Clustered/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Star/ })).toBeInTheDocument();
  });

  test("GraphHUD renders all five graph mode buttons", () => {
    renderGraphHUD();

    expect(screen.getByRole("button", { name: /Force/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clustered/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Star/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Orbital/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Time/ })).toBeInTheDocument();
  });

  test("GraphHUD fires onModeChange when clicked", () => {
    const onModeChange = vi.fn();
    renderGraphHUD({ onModeChange });

    fireEvent.click(screen.getByRole("button", { name: /Clustered/ }));

    expect(onModeChange).toHaveBeenCalledWith("clustered");
  });

  test("GraphHUD entity filter toggles", () => {
    const onToggleType = vi.fn();
    renderGraphHUD({ onToggleType });

    fireEvent.click(screen.getByLabelText("projects"));

    expect(onToggleType).toHaveBeenCalledWith("projects");
  });

  test("GraphHUD search input fires onSearchChange with the typed value", () => {
    const onSearchChange = vi.fn();
    renderGraphHUD({ searchMatchCount: 2, searchQuery: "memo", onSearchChange });

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "memory" } });

    expect(onSearchChange).toHaveBeenCalledWith("memory");
    expect(screen.getByText("2 matches")).toBeInTheDocument();
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

  test("TimelineScrubber fires onChange when slider moves", () => {
    const onChange = vi.fn();
    render(<TimelineScrubber maxAgeDays={30} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Timeline scrubber"), { target: { value: "90" } });

    expect(onChange).toHaveBeenCalledWith(90);
  });

  test("TimelineScrubber preset button fires onChange with preset days", () => {
    const onChange = vi.fn();
    render(<TimelineScrubber maxAgeDays={30} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "1w" }));

    expect(onChange).toHaveBeenCalledWith(7);
  });
});
