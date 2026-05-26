import { describe, expect, it } from "vitest";
import { computeEdgeRenderStyle } from "../../../src/dashboard-ui/components/GalacticCanvas.js";

describe("galactic edge rendering", () => {
  it("floors all edge visibility at galactic zoom", () => {
    const style = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "semantic",
      weight: 0.1,
      zoomLevel: 0,
    });

    expect(style.lineWidth).toBeGreaterThanOrEqual(0.8);
    expect(style.opacity).toBeGreaterThanOrEqual(0.35);
  });

  it("boosts cross-galaxy edge width and opacity by at least 1.5x", () => {
    const within = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "semantic",
      weight: 0.6,
      zoomLevel: 0,
    });
    const cross = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "episodic",
      weight: 0.6,
      zoomLevel: 0,
    });

    expect(cross.lineWidth).toBeGreaterThanOrEqual(within.lineWidth * 1.5);
    expect(cross.opacity).toBeGreaterThanOrEqual(within.opacity * 1.5);
  });

  it("keeps non-galactic zoom levels on the existing weight-driven scale", () => {
    const style = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "semantic",
      weight: 0.1,
      zoomLevel: 1,
    });

    expect(style.lineWidth).toBeCloseTo(0.46);
    expect(style.opacity).toBeCloseTo(0.235);
  });
});
