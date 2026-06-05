import { describe, expect, it } from "vitest";
import { buildGalacticLayout, COGNITIVE_ORDER, DOMAIN_ORDER, planetRadiusForMass } from "../../../../src/dashboard-ui/lib/galactic/layout.js";
import type { GraphNode } from "../../../../src/dashboard-ui/hooks/useGraph.js";

function node(path: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    path,
    title: path,
    kind: "wiki",
    type: "projects",
    cognitiveType: "semantic",
    confidence: 0.8,
    updated: "2026-05-24",
    inboundCount: 1,
    outboundCount: 0,
    ...overrides,
  };
}

describe("galactic layout", () => {
  it("places the four cognitive galaxies on a tetrahedron", () => {
    const layout = buildGalacticLayout([]);

    expect(Object.keys(layout.galaxies)).toEqual([...COGNITIVE_ORDER]);

    const R = 900;
    expect(layout.galaxies.core.cx).toBeCloseTo(0, 3);
    expect(layout.galaxies.core.cy).toBeCloseTo(R, 3);
    expect(layout.galaxies.core.cz).toBeCloseTo(0, 3);

    expect(layout.galaxies.semantic.cx).toBeCloseTo(Math.sqrt(8 / 9) * R, 3);
    expect(layout.galaxies.semantic.cy).toBeCloseTo(-R / 3, 3);

    expect(layout.galaxies.episodic.cy).toBeCloseTo(-R / 3, 3);
    expect(layout.galaxies.procedural.cy).toBeCloseTo(-R / 3, 3);

    const centers = COGNITIVE_ORDER.map((k) => {
      const g = layout.galaxies[k];
      return [g.cx, g.cy, g.cz] as const;
    });
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const d = Math.hypot(
          centers[i][0] - centers[j][0],
          centers[i][1] - centers[j][1],
          centers[i][2] - centers[j][2],
        );
        expect(d).toBeGreaterThan(R * 1.2);
      }
    }
  });

  it("clusters nodes into domain systems within each cognitive galaxy", () => {
    const layout = buildGalacticLayout([
      node("wiki/projects/a.md", { cognitiveType: "core", type: "projects" }),
      node("wiki/tools/b.md", { cognitiveType: "core", type: "tools" }),
    ]);

    const project = layout.nodes.find((item) => item.path === "wiki/projects/a.md");
    const tool = layout.nodes.find((item) => item.path === "wiki/tools/b.md");

    expect(project?.galaxy.id).toBe("core");
    expect(project?.system.id).toBe("projects");
    expect(tool?.system.id).toBe("tools");
    expect(Object.keys(layout.galaxies.core.systems)).toEqual(
      DOMAIN_ORDER.filter((domain) => domain === "projects" || domain === "tools"),
    );
  });

  it("gives heavier inbound nodes more mass and a tighter orbit", () => {
    const light = planetRadiusForMass(0, 0);
    const heavy = planetRadiusForMass(16, 0);

    expect(heavy.mass).toBe(1);
    expect(heavy.localOrbitR).toBeLessThan(light.localOrbitR);
    expect(heavy.size).toBeGreaterThan(light.size);
  });
});
