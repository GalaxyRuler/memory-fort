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

  it("follows the camera (not the selection) on zoom-level change", () => {
    // Selection-priority pulled the camera back to whatever galaxy the
    // last-selected node lived in — with 86% of nodes in Semantic, that
    // meant every zoom-level click felt like 'pulled to Semantic'.
    // Fix: always follow the camera. Click-to-pan is a separate concern.
    const layout = buildGalacticLayout(fixtureNodes, []);

    const target = selectZoomTarget({
      camera: { camX: layout.galaxies.core.cx, camY: layout.galaxies.core.cy, scale: 0.18 },
      layout,
      level: 2,
      selectedNodeId: "procedural.md", // selected node lives in procedural galaxy
    });

    // Camera is at core, so we stay at core regardless of selection.
    expect(target).toEqual({
      cx: layout.galaxies.core.cx,
      cy: layout.galaxies.core.cy,
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
    status: "active",
    source: "manual",
    created: "2026-05-20",
    tags: [],
    description: "",
    confidence: 0,
    updated: null,
    inboundCount: 0,
    outboundCount: 0,
    cognitiveType,
  };
}
