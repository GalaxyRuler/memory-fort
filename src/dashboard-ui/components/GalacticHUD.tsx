import type { GraphEdge, GraphNode, GraphScope } from "../hooks/useGraph.js";
import type { GalacticZoomLevel } from "./GalacticCanvas.js";
import { GlassPanel } from "./GlassPanel.js";
import { Inspector } from "./galactic/Inspector.js";
import { Legend } from "./galactic/Legend.js";
import { ScopeToggle } from "./galactic/ScopeToggle.js";
import { ZoomIndicator } from "./galactic/ZoomIndicator.js";

export interface GalacticHUDProps {
  zoomLevel: GalacticZoomLevel;
  scope: GraphScope;
  selectedNode: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  onZoomLevelChange: (level: GalacticZoomLevel) => void;
  onScopeChange: (scope: GraphScope) => void;
  onOpenMemory: (path: string) => void;
  onSelectNode: (path: string | null) => void;
  onDeselect: () => void;
}

export function GalacticHUD({
  edges,
  nodes,
  onDeselect,
  onOpenMemory,
  onScopeChange,
  onSelectNode,
  onZoomLevelChange,
  scope,
  selectedNode,
  zoomLevel,
}: GalacticHUDProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      <div className="pointer-events-auto absolute left-3 top-3">
        <ScopeToggle scope={scope} onChange={onScopeChange} />
      </div>
      <div className="pointer-events-auto absolute left-1/2 top-3 -translate-x-1/2">
        <ZoomIndicator level={zoomLevel} onChange={onZoomLevelChange} />
      </div>
      <GlassPanel hasBrackets={true} className="pointer-events-auto absolute right-3 top-3 w-72 bg-surface/65">
        <Legend nodes={nodes} />
      </GlassPanel>
      <GlassPanel hasBrackets={true} className="pointer-events-auto absolute bottom-3 left-3 bg-surface/65 px-3 py-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
          <span>drag pan</span>
          <span>wheel zoom</span>
          <span>click select</span>
          <span>1/2/3 zoom</span>
          <span>Esc reset</span>
        </div>
      </GlassPanel>
      {selectedNode && (
        <GlassPanel hasBrackets={true} className="pointer-events-auto absolute bottom-3 right-3 max-h-[calc(100vh-7rem)] w-[420px] overflow-auto bg-surface/75">
          <Inspector edges={edges} node={selectedNode} nodes={nodes} onClose={onDeselect} onOpenMemory={onOpenMemory} onSelectNode={onSelectNode} />
        </GlassPanel>
      )}
    </div>
  );
}
