import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GraphPage } from "../../../src/dashboard-ui/components/GraphPage.js";
import type { GalacticCanvasHandle, GalacticCanvasProps } from "../../../src/dashboard-ui/components/GalacticCanvas.js";
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
    edges: [{ fromPath: "wiki/projects/core.md", toPath: "wiki/references/ref.md", kind: "wikilink", relationType: null }],
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
    expect(screen.getByText("Core Memory")).toBeInTheDocument();
    expect(canvasCalls.focusNode).toHaveBeenCalledWith("wiki/projects/core.md");

    fireEvent.click(screen.getByRole("button", { name: /Open Memory/ }));
    expect(screen.getByTestId("memory-modal")).toHaveTextContent("wiki/projects/core.md");
  });

  test("keyboard zoom shortcuts drive the canvas handle", () => {
    render(<GraphPage />);

    fireEvent.keyDown(document, { key: "3" });

    expect(canvasCalls.setZoomLevel).toHaveBeenCalledWith(2);
  });
});
