import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GalacticScene } from "../../../src/dashboard-ui/components/GalacticScene.js";

const r3fState = vi.hoisted(() => ({
  cameraDistance: 32,
  frameCallbacks: [] as Array<(state: any, delta: number) => void>,
}));

vi.mock("@react-three/fiber", async () => {
  const ReactModule = await import("react");
  return {
    Canvas: ({ children, camera: _camera, dpr: _dpr, gl: _gl, ...props }: any) =>
      ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement("canvas", { ...props, "data-testid": "r3f-canvas" }),
        children,
      ),
    extend: vi.fn(),
    useFrame: vi.fn((callback) => {
      r3fState.frameCallbacks.push(callback);
    }),
    useThree: vi.fn(() => ({
      camera: {
        position: {
          copy: vi.fn(),
          distanceTo: vi.fn(() => 10),
          length: vi.fn(() => r3fState.cameraDistance),
          lerp: vi.fn(),
        },
      },
    })),
  };
});

vi.mock("@react-three/drei", () => ({
  OrbitControls: () => null,
  Stars: () => null,
}));

vi.mock("@react-three/postprocessing", () => ({
  Bloom: () => null,
  EffectComposer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("GalacticScene accessibility", () => {
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    r3fState.cameraDistance = 32;
    r3fState.frameCallbacks = [];
    originalConsoleError = console.error;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const message = String(args[0] ?? "");
      if (
        message.includes("is unrecognized in this browser") ||
        message.includes("is using incorrect casing") ||
        message.includes("React does not recognize the") ||
        message.includes("non-boolean attribute")
      ) {
        return;
      }
      originalConsoleError(...args);
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fillRect: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  });

  afterEach(() => {
    document.body.style.cursor = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("names the WebGL graph canvas as a non-text image", () => {
    render(
      <GalacticScene
        nodes={[]}
        edges={[]}
      />,
    );

    expect(screen.getByRole("img", { name: "Memory knowledge graph" })).toBe(screen.getByTestId("r3f-canvas"));
  });

  test("cleans up a scene-owned pointer cursor on unmount", () => {
    document.body.style.cursor = "pointer";
    const { unmount } = render(
      <GalacticScene
        nodes={[]}
        edges={[]}
      />,
    );

    unmount();

    expect(document.body.style.cursor).toBe("auto");
  });

  test("emits zoom level changes from camera distance", () => {
    const onZoomLevelChange = vi.fn();
    render(
      <GalacticScene
        nodes={[]}
        edges={[]}
        onZoomLevelChange={onZoomLevelChange}
      />,
    );

    r3fState.cameraDistance = 10;
    r3fState.frameCallbacks[0]?.({ clock: { getElapsedTime: () => 0 } }, 0.016);
    r3fState.frameCallbacks[0]?.({ clock: { getElapsedTime: () => 0 } }, 0.016);

    expect(onZoomLevelChange).toHaveBeenCalledWith(1);
    expect(onZoomLevelChange).toHaveBeenCalledTimes(1);
  });
});
