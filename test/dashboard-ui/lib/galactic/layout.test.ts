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
  it("places the four cognitive galaxies on the prototype ring", () => {
    const layout = buildGalacticLayout([]);

    expect(Object.keys(layout.galaxies)).toEqual([...COGNITIVE_ORDER]);
    expect(layout.galaxies.core.cx).toBeCloseTo(0, 5);
    expect(layout.galaxies.core.cy).toBeCloseTo(-900, 5);
    expect(layout.galaxies.semantic.cx).toBeCloseTo(900, 5);
    expect(layout.galaxies.semantic.cy).toBeCloseTo(0, 5);
    expect(layout.galaxies.episodic.cx).toBeCloseTo(0, 5);
    expect(layout.galaxies.episodic.cy).toBeCloseTo(900, 5);
    expect(layout.galaxies.procedural.cx).toBeCloseTo(-900, 5);
    expect(layout.galaxies.procedural.cy).toBeCloseTo(0, 5);
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
