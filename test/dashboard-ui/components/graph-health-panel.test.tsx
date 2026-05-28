import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphHealthPanel } from "../../../src/dashboard-ui/components/GraphHealthPanel.js";
import { useGraphHealth, type GraphHealthReport } from "../../../src/dashboard-ui/hooks/useGraphHealth.js";

vi.mock("../../../src/dashboard-ui/hooks/useGraphHealth.js", () => ({
  useGraphHealth: vi.fn(),
}));

const mockUseGraphHealth = vi.mocked(useGraphHealth);

describe("GraphHealthPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders a collapsed summary by default", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel />);

    expect(screen.getByText("Graph Health")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Graph health: 1\/4 passing . 1 warn . 1 fail/i })).toBeInTheDocument();
    expect(screen.queryByTestId("graph-health-card")).not.toBeInTheDocument();
  });

  it("expands metric cards sorted fail, warn, pass, n/a and persists the preference", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Graph health:/i }));

    expect(screen.getAllByTestId("graph-health-card").map((card) => card.getAttribute("data-metric-id"))).toEqual([
      "graph.agent-attribution",
      "graph.hub-overload",
      "graph.edge-type-entropy",
      "graph.narrative-thread-coverage",
    ]);
    expect(window.localStorage.getItem("mf:overview:graph-health-expanded")).toBe("true");
  });

  it("links overview metric tiles to the graph health drill-down route", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Graph health:/i }));

    expect(screen.getAllByTestId("graph-health-card")[0]).toHaveAttribute(
      "data-health-href",
      "/memory/health#graph.agent-attribution",
    );
  });

  it("expands offender details inline", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel defaultExpanded persistExpansion={false} detailMode />);
    fireEvent.click(screen.getByRole("button", { name: /details for Agent attribution/i }));

    expect(screen.getByText("wiki/tools/missing-source.md")).toBeInTheDocument();
    expect(screen.getByText("missing source")).toBeInTheDocument();
  });

  it("renders exempt offender notes", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel defaultExpanded persistExpansion={false} detailMode />);
    fireEvent.click(screen.getByRole("button", { name: /details for Hub overload/i }));

    expect(screen.getByText("wiki/projects/hub.md")).toBeInTheDocument();
    expect(screen.getByText("exempt (project hub - by-design anchor); 250 inbound, 0 outbound")).toBeInTheDocument();
  });

  it("renders n/a metrics compactly with Phase 4 detail text", () => {
    mockUseGraphHealth.mockReturnValue(query(report()));

    render(<GraphHealthPanel defaultExpanded persistExpansion={false} />);

    expect(screen.getByText("Narrative thread coverage")).toBeInTheDocument();
    expect(screen.getByText("pending narrative threads in Phase 4")).toBeInTheDocument();
  });
});

function query(data: GraphHealthReport): ReturnType<typeof useGraphHealth> {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useGraphHealth>;
}

function report(): GraphHealthReport {
  return {
    computedAt: "2026-05-27T00:00:00.000Z",
    overallStatus: "fail",
    metrics: [
      {
        id: "graph.edge-type-entropy",
        label: "Edge type entropy",
        value: 1.2,
        unit: "bits",
        threshold: { warn: 0.8, fail: 0.4, rule: "warn < 0.8 bits" },
        status: "pass",
        detail: "healthy type distribution",
        topOffenders: [],
      },
      {
        id: "graph.narrative-thread-coverage",
        label: "Narrative thread coverage",
        value: null,
        threshold: { rule: "pending narrative threads in Phase 4" },
        status: "n/a",
        detail: "pending narrative threads in Phase 4",
        topOffenders: [],
      },
      {
        id: "graph.hub-overload",
        label: "Hub overload (non-project nodes)",
        value: 250,
        unit: "count",
        threshold: { warn: 200, fail: 650, rule: "warn > 200 edges, fail > 650 edges" },
        status: "warn",
        detail: "highest non-exempt single-node degree is 250",
        topOffenders: [{
          path: "wiki/projects/hub.md",
          value: 250,
          note: "exempt (project hub - by-design anchor); 250 inbound, 0 outbound",
        }],
      },
      {
        id: "graph.agent-attribution",
        label: "Agent attribution",
        value: 50,
        unit: "%",
        threshold: { warn: 90, fail: 70, rule: "warn < 90%" },
        status: "fail",
        detail: "1/2 wiki pages have source",
        topOffenders: [{ path: "wiki/tools/missing-source.md", note: "missing source" }],
      },
    ],
  };
}
