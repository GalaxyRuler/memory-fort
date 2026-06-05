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

  it("demotes untyped cross-galaxy edges below within-galaxy edges", () => {
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

    // Cross-galaxy is the ~94% base rate: quiet slate, no glow, fainter than the
    // rarer within-galaxy edges — not boosted on top of them.
    expect(cross.opacity).toBeLessThan(within.opacity);
    expect(cross.glow).toBe(false);
    expect(cross.strokeColor).toContain("100, 116, 139");
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

  it("renders typed relation edges with stable semantic treatments", () => {
    expect(styleFor("contradicts")).toMatchObject({
      strokeColor: "rgba(252, 165, 165, 0.76)",
      dash: [6, 4],
      arrowhead: false,
      glow: false,
    });
    expect(styleFor("supersedes")).toMatchObject({
      strokeColor: "rgba(156, 163, 175, 0.76)",
      dash: [],
      arrowhead: true,
      glow: false,
    });
    expect(styleFor("derived_from")).toMatchObject({
      strokeColor: "rgba(165, 180, 252, 0.76)",
      dash: [2, 3],
      arrowhead: false,
      glow: false,
    });
  });

  it("lets canonical typed edges override the cross-galaxy cyan fallback", () => {
    const style = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "episodic",
      weight: 0.6,
      zoomLevel: 0,
      type: "contradicts",
    });

    // Typed cross-galaxy edges keep their semantic color at full weight-driven
    // opacity (no cross-galaxy mute) so meaningful relations stay legible.
    expect(style.strokeColor).toBe("rgba(252, 165, 165, 0.41)");
    expect(style.glow).toBe(false);
  });

  it("demotes dropped noncanonical supports edges to quiet slate", () => {
    const style = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "episodic",
      weight: 0.6,
      zoomLevel: 0,
      type: "supports",
    });

    expect(style.strokeColor).toBe("rgba(100, 116, 139, 0.2255)");
    expect(style.glow).toBe(false);
  });

  it("mutes untyped cross-galaxy mentions and fades historical edges further", () => {
    const active = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "episodic",
      weight: 0.6,
      zoomLevel: 0,
      type: "mentions",
    });
    const historical = computeEdgeRenderStyle({
      highlighted: false,
      sourceCognitiveType: "semantic",
      targetCognitiveType: "episodic",
      weight: 0.6,
      zoomLevel: 0,
      type: "mentions",
      validTo: "2026-05-23",
    });

    expect(active.strokeColor).toBe("rgba(100, 116, 139, 0.2255)");
    expect(active.glow).toBe(false);
    expect(historical.opacity).toBeCloseTo(active.opacity * 0.4);
    expect(historical.strokeColor).toBe("rgba(100, 116, 139, 0.0902)");
    expect(historical.glow).toBe(false);
  });
});

function styleFor(type: string) {
  return computeEdgeRenderStyle({
    highlighted: true,
    sourceCognitiveType: "semantic",
    targetCognitiveType: "semantic",
    weight: 0.6,
    zoomLevel: 1,
    type,
  });
}
