import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GraphCanvas } from "../../../src/dashboard-ui/components/GraphCanvas.js";
import type { GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";

const forceGraphMock = vi.hoisted(() => {
  const linkForce = {
    distance: vi.fn().mockReturnThis(),
    strength: vi.fn().mockReturnThis(),
  };
  const strengthForce = {
    strength: vi.fn().mockReturnThis(),
  };

  return {
    camera: {
      aspect: 1,
      updateProjectionMatrix: vi.fn(),
    },
    d3Force: vi.fn((name: string) => (name === "link" ? linkForce : strengthForce)),
    d3ReheatSimulation: vi.fn(),
    parentStyle: {} as Record<string, string>,
    renderer: {
      setSize: vi.fn(),
      domElement: {
        parentElement: {
          style: {} as Record<string, string>,
        },
      },
    },
    zoomToFit: vi.fn(),
  };
});

vi.mock("react-force-graph-3d", async () => {
  const React = await import("react");
  const ForceGraph3D = React.forwardRef((props: Record<string, unknown>, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      camera: () => forceGraphMock.camera,
      d3Force: forceGraphMock.d3Force,
      d3ReheatSimulation: forceGraphMock.d3ReheatSimulation,
      renderer: () => forceGraphMock.renderer,
      zoomToFit: forceGraphMock.zoomToFit,
    }));

    return React.createElement("button", {
      "data-testid": "force-graph",
      onClick: () => props.onEngineStop?.(),
      type: "button",
    });
  });

  return { default: ForceGraph3D };
});

vi.mock("../../../src/dashboard-ui/lib/reduced-motion.js", () => ({
  useReducedMotion: () => false,
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

describe("GraphCanvas", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    forceGraphMock.camera.aspect = 1;
    forceGraphMock.d3Force.mockClear();
    forceGraphMock.d3ReheatSimulation.mockClear();
    forceGraphMock.renderer.setSize.mockClear();
    forceGraphMock.renderer.domElement.parentElement.style = {};
    forceGraphMock.zoomToFit.mockClear();
    forceGraphMock.camera.updateProjectionMatrix.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("imperatively resizes the force graph renderer and auto-fits the camera", async () => {
    render(
      <GraphCanvas
        edges={[]}
        enabledTypes={new Set(["projects"])}
        height={720}
        mode="force"
        nodes={[graphNode()]}
        onNodeClick={vi.fn()}
        width={1280}
      />,
    );

    expect(forceGraphMock.renderer.setSize).toHaveBeenCalledWith(1280, 720);
    expect(forceGraphMock.camera.aspect).toBeCloseTo(1280 / 720);
    expect(forceGraphMock.camera.updateProjectionMatrix).toHaveBeenCalled();
    expect(forceGraphMock.renderer.domElement.parentElement.style).toMatchObject({
      height: "720px",
      width: "1280px",
    });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(forceGraphMock.zoomToFit).toHaveBeenCalledWith(400, 50);
  });
});
