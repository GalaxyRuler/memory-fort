import { describe, expect, it } from "vitest";
import { confidenceGlow, edgeLensing, massPull, zoomLevelForScale } from "../../../../src/dashboard-ui/lib/galactic/physics.js";

describe("galactic physics", () => {
  it("pulls high-mass planets toward their cognitive galaxy core", () => {
    const low = massPull({ x: 220, y: 0 }, { x: 0, y: 0 }, 0);
    const high = massPull({ x: 220, y: 0 }, { x: 0, y: 0 }, 1);

    expect(low).toEqual({ x: 220, y: 0, pull: 0 });
    expect(high.pull).toBe(0.5);
    expect(high.x).toBe(110);
    expect(high.y).toBe(0);
  });

  it("computes stronger edge lensing for heavier relation weights", () => {
    const weak = edgeLensing({ x: -100, y: 0 }, { x: 100, y: 0 }, { x: 0, y: -900 }, 0.4);
    const strong = edgeLensing({ x: -100, y: 0 }, { x: 100, y: 0 }, { x: 0, y: -900 }, 1.4);

    expect(strong.warp).toBeGreaterThan(weak.warp);
    expect(strong.controlY).toBeLessThan(weak.controlY);
  });

  it("maps confidence to larger, brighter halos", () => {
    const low = confidenceGlow(0.2, 10);
    const high = confidenceGlow(0.95, 10);

    expect(high.radius).toBeGreaterThan(low.radius);
    expect(high.opacity).toBeGreaterThan(low.opacity);
  });

  it("derives the prototype zoom levels from camera scale", () => {
    expect(zoomLevelForScale(0.18)).toBe(0);
    expect(zoomLevelForScale(0.55)).toBe(1);
    expect(zoomLevelForScale(1.4)).toBe(2);
  });
});
