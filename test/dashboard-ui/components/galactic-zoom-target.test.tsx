import { describe, expect, it } from "vitest";
import type { CognitiveType, GraphNode } from "../../../src/dashboard-ui/hooks/useGraph.js";
import { buildGalacticLayout } from "../../../src/dashboard-ui/lib/galactic/layout.js";
import { selectZoomTarget } from "../../../src/dashboard-ui/components/GalacticCanvas.js";

const fixtureNodes: GraphNode[] = [
  node("core.md", "core"),
  node("semantic.md", "semantic"),
  node("episodic.md", "episodic"),
  node("procedural.md", "procedural"),
];

describe("galactic zoom target selection", () => {
  it.each(["procedural", "episodic", "core"] as const)(
    "targets the nearest %s galaxy when changing zoom with no selected node",
    (cognitiveType) => {
      const layout = buildGalacticLayout(fixtureNodes, []);
      const galaxy = layout.galaxies[cognitiveType];

      const target = selectZoomTarget({
        camera: { camX: galaxy.cx + 24, camY: galaxy.cy - 16, scale: 0.18 },
        layout,
        level: 1,
        selectedNodeId: null,
      });

      expect(target).toEqual({ cx: galaxy.cx, cy: galaxy.cy });
      expect(target).not.toEqual({
        cx: layout.galaxies.semantic.cx,
        cy: layout.galaxies.semantic.cy,
      });
    },
  );

  it("targets the selected node galaxy when a node is selected", () => {
    const layout = buildGalacticLayout(fixtureNodes, []);

    const target = selectZoomTarget({
      camera: { camX: layout.galaxies.core.cx, camY: layout.galaxies.core.cy, scale: 0.18 },
      layout,
      level: 2,
      selectedNodeId: "procedural.md",
    });

    expect(target).toEqual({
      cx: layout.galaxies.procedural.cx,
      cy: layout.galaxies.procedural.cy,
    });
  });

  it("targets world origin at galactic zoom regardless of current focus", () => {
    const layout = buildGalacticLayout(fixtureNodes, []);

    expect(
      selectZoomTarget({
        camera: { camX: layout.galaxies.procedural.cx, camY: layout.galaxies.procedural.cy, scale: 1.4 },
        layout,
        level: 0,
        selectedNodeId: "procedural.md",
      }),
    ).toEqual({ cx: 0, cy: 0 });
  });
});

function node(path: string, cognitiveType: CognitiveType): GraphNode {
  return {
    path,
    title: path,
    kind: "wiki",
    type: "projects",
    tags: [],
    updatedAt: null,
    summary: "",
    score: 0,
    inboundCount: 0,
    outboundCount: 0,
    cognitiveType,
  };
}
