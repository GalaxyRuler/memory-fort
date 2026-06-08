import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GraphPage } from "../../../src/dashboard-ui/components/GraphPage.js";
import type { GalacticCanvasHandle, GalacticCanvasProps } from "../../../src/dashboard-ui/components/GalacticCanvas.js";
import type { GalacticSceneHandle, GalacticSceneProps } from "../../../src/dashboard-ui/components/GalacticScene.js";
import type { GraphNode, GraphResponse } from "../../../src/dashboard-ui/hooks/useGraph.js";

const graphHook = vi.hoisted(() => ({
  useGraph: vi.fn(),
}));

const canvasCalls = vi.hoisted(() => ({
  focusNode: vi.fn(),
  setZoomLevel: vi.fn(),
}));

vi.mock("../../../src/dashboard-ui/hooks/useGraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/dashboard-ui/hooks/useGraph.js")>();
  return {
    ...actual,
    useGraph: graphHook.useGraph,
  };
});

vi.mock("../../../src/dashboard-ui/components/GalacticCanvas.js", async () => {
  const ReactModule = await import("react");
  return {
    GalacticCanvas: ReactModule.forwardRef((props: GalacticCanvasProps, ref: React.ForwardedRef<GalacticCanvasHandle>) => {
      ReactModule.useImperativeHandle(ref, () => ({
        focusNode: canvasCalls.focusNode,
        setZoomLevel: canvasCalls.setZoomLevel,
      }));

      return (
        <button
          type="button"
          data-testid="galactic-canvas-shell"
          onClick={() => props.onSelectNode?.("wiki/projects/core.md")}
        >
          galactic canvas
        </button>
      );
    }),
  };
});

vi.mock("../../../src/dashboard-ui/components/GalacticScene.js", async () => {
  const ReactModule = await import("react");
  return {
    GalacticScene: ReactModule.forwardRef((props: GalacticSceneProps, ref: React.ForwardedRef<GalacticSceneHandle>) => {
      ReactModule.useImperativeHandle(ref, () => ({
        focusNode: canvasCalls.focusNode,
        setZoomLevel: canvasCalls.setZoomLevel,
      }));

      return (
        <div>
          <button
            type="button"
            data-testid="galactic-canvas-shell"
            onClick={() => props.onSelectNode?.("wiki/projects/core.md")}
          >
            galactic canvas
          </button>
          <button
            type="button"
            data-testid="galaxy-core"
            onClick={() => props.onGalaxyClusterClick?.("core")}
          >
            galaxy core
          </button>
          <button
            type="button"
            data-testid="scene-zoom-memory"
            onClick={() => props.onZoomLevelChange?.(1)}
          >
            scene zoom memory
          </button>
        </div>
      );
    }),
  };
});

vi.mock("../../../src/dashboard-ui/components/galactic/MemoryModal.js", () => ({
  MemoryModal: ({ path }: { path: string }) => <div data-testid="memory-modal">modal {path}</div>,
}));

const originalMatchMedia = window.matchMedia;

function setDesktopMedia() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("pointer: fine"),
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

function graphNode(path: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path,
    title: path.split("/").at(-1)?.replace(".md", "") ?? path,
    kind: "wiki",
    type: "projects",
    cognitiveType: "core",
    status: "active",
    source: "manual",
    created: "2026-05-20",
    confidence: 0.9,
    tags: ["graph"],
    description: "A routed memory node.",
    updated: "2026-05-24",
    inboundCount: 8,
    outboundCount: 2,
    ...overrides,
  };
}

function graphResponse(): GraphResponse {
  return {
    nodes: [
      graphNode("wiki/projects/core.md", { title: "Core Memory" }),
      graphNode("wiki/references/ref.md", { title: "Reference Memory", type: "references", cognitiveType: "semantic" }),
    ],
    edges: [{ fromPath: "wiki/projects/core.md", toPath: "wiki/references/ref.md", kind: "wikilink", relationType: null, type: "wikilink" }],
    unresolvedTargets: [],
  };
}

describe("Galactic GraphPage", () => {
  beforeEach(() => {
    setDesktopMedia();
    canvasCalls.focusNode.mockClear();
    canvasCalls.setZoomLevel.mockClear();
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

  test("renders the galactic canvas and opens selected memories from the inspector", () => {
    render(<GraphPage />);

    fireEvent.click(screen.getByTestId("galactic-canvas-shell"));
    expect(screen.getByRole("heading", { level: 2, name: "Core Memory" })).toBeInTheDocument();
    expect(canvasCalls.focusNode).toHaveBeenCalledWith("wiki/projects/core.md");

    fireEvent.click(screen.getByRole("button", { name: /Open Memory/ }));
    expect(screen.getByTestId("memory-modal")).toHaveTextContent("wiki/projects/core.md");
  });

  test("keeps the grouped graph text alternative available on desktop", () => {
    render(<GraphPage />);

    const textAlternative = screen.getByRole("region", {
      name: "Memory knowledge graph text alternative",
    });
    expect(textAlternative).toHaveClass("sr-only");
    expect(textAlternative).toHaveTextContent("Open on desktop for the 3D view");
    expect(textAlternative).toHaveTextContent("Core Memory");
    expect(textAlternative).toHaveTextContent("Reference Memory");
    expect(screen.getByTestId("galactic-canvas-shell")).toBeInTheDocument();
  });

  test("shows a galaxy zoom hint when a galaxy cluster is clicked", () => {
    render(<GraphPage />);

    expect(screen.queryByText("Zoom in to select individual memories")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("galaxy-core"));

    expect(screen.getByRole("status")).toHaveTextContent("Zoom in to select individual memories");
  });

  test("does not show the galaxy zoom hint after the scene reports memory zoom", () => {
    render(<GraphPage />);

    fireEvent.click(screen.getByTestId("scene-zoom-memory"));
    fireEvent.click(screen.getByTestId("galaxy-core"));

    expect(screen.queryByText("Zoom in to select individual memories")).not.toBeInTheDocument();
  });

  test("list view exposes keyboard-reachable nodes that open the memory modal", () => {
    render(<GraphPage />);

    // Graph view by default — the canvas is present, no interactive node buttons.
    expect(screen.getByTestId("galactic-canvas-shell")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Core Memory/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    // Canvas is gone; nodes are now focusable buttons a keyboard user can reach.
    expect(screen.queryByTestId("galactic-canvas-shell")).not.toBeInTheDocument();
    const nodeButton = screen.getByRole("button", { name: /Core Memory/ });
    fireEvent.click(nodeButton);
    expect(screen.getByTestId("memory-modal")).toHaveTextContent("wiki/projects/core.md");

    // Toggle is reversible.
    fireEvent.click(screen.getByRole("button", { name: "Graph view" }));
    expect(screen.getByTestId("galactic-canvas-shell")).toBeInTheDocument();
  });

  test("keyboard zoom shortcuts drive the canvas handle", () => {
    render(<GraphPage />);

    fireEvent.keyDown(document, { key: "3" });

    expect(canvasCalls.setZoomLevel).toHaveBeenCalledWith(2);
  });
});
