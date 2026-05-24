import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GraphPage } from "../../../src/dashboard-ui/components/GraphPage.js";
import type { GraphResponse } from "../../../src/dashboard-ui/hooks/useGraph.js";

const graphHook = vi.hoisted(() => ({
  useGraph: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useGraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useGraph.js")>();
  return {
    ...actual,
    useGraph: graphHook.useGraph,
  };
});

vi.mock("../../../src/dashboard-ui/components/GraphCanvas.js", () => ({
  GraphCanvas: () => <div data-testid="graph-canvas">3D graph canvas</div>,
}));

const originalMatchMedia = window.matchMedia;

function setMobileMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width") ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function graphResponse(): GraphResponse {
  return {
    nodes: [
      {
        path: "wiki/projects/memory-system.md",
        title: "Memory System",
        kind: "wiki",
        type: "projects",
        confidence: 0.91,
        updated: "2026-05-24",
        inboundCount: 3,
        outboundCount: 5,
      },
      {
        path: "wiki/decisions/mobile-dashboard.md",
        title: "Mobile Dashboard",
        kind: "wiki",
        type: "decisions",
        confidence: 0.84,
        updated: "2026-05-23",
        inboundCount: 2,
        outboundCount: 4,
      },
    ],
    edges: [],
    unresolvedTargets: [],
  };
}

describe("GraphPage mobile fallback", () => {
  beforeEach(() => {
    setMobileMedia(true);
    graphHook.useGraph.mockReturnValue({
      data: graphResponse(),
      error: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    graphHook.useGraph.mockReset();
  });

  test("renders grouped node lists instead of the 3D canvas on small viewports", () => {
    render(<GraphPage />);

    expect(screen.getByText("Open on desktop for the 3D view")).toBeInTheDocument();
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("Memory System")).toBeInTheDocument();
    expect(screen.getByText("decisions")).toBeInTheDocument();
    expect(screen.getByText("Mobile Dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();
  });
});
