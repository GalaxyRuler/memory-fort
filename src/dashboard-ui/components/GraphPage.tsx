import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type CognitiveType, type GraphNode, type GraphScope, useGraph } from "../hooks/useGraph.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import type { GalacticZoomLevel } from "./GalacticCanvas.js";
import { GalacticScene, type GalacticSceneHandle } from "./GalacticScene.js";
import { GalacticHUD } from "./GalacticHUD.js";
import { MemoryModal } from "./galactic/MemoryModal.js";

export function GraphPage() {
  // Default to the curated wiki scope: it loads in ~60ms (vs ~3s for the full
  // ~1900-node corpus), so the graph paints instantly. The scope toggle lets the
  // user pull in raw / crystals / all on demand.
  const [scope, setScope] = useState<GraphScope>("wiki");
  const graph = useGraph(scope);
  const isBelowMd = useMediaQuery("(max-width: 767px)");
  const hasFinePointer = useMediaQuery("(pointer: fine)", true);
  const canvasRef = useRef<GalacticSceneHandle>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<GalacticZoomLevel>(0);
  const [showGalaxyZoomHint, setShowGalaxyZoomHint] = useState(false);
  const [openMemoryPath, setOpenMemoryPath] = useState<string | null>(null);
  // List view gives sighted keyboard-only users a way to reach and open nodes
  // that the pointer-driven WebGL canvas cannot (A11Y: WCAG 2.1.1 Keyboard).
  const [viewMode, setViewMode] = useState<"graph" | "list">("graph");

  const selectedNode = useMemo(() => {
    return graph.data?.nodes.find((node) => node.path === selectedNodeId) ?? null;
  }, [graph.data?.nodes, selectedNodeId]);

  const selectNode = useCallback((path: string | null) => {
    setSelectedNodeId(path);
    setShowGalaxyZoomHint(false);
    if (path) {
      canvasRef.current?.focusNode(path);
    }
  }, []);

  const handleZoomLevelChange = useCallback((level: GalacticZoomLevel) => {
    setZoomLevel(level);
    setShowGalaxyZoomHint(false);
    canvasRef.current?.setZoomLevel(level);
  }, []);

  const handleSceneZoomLevelChange = useCallback((level: GalacticZoomLevel) => {
    setZoomLevel(level);
    if (level !== 0) {
      setShowGalaxyZoomHint(false);
    }
  }, []);

  const handleGalaxyClusterClick = useCallback((_type: CognitiveType) => {
    if (zoomLevel === 0) {
      setShowGalaxyZoomHint(true);
    }
  }, [zoomLevel]);

  const handleScopeChange = useCallback((next: GraphScope) => {
    // The node set changes, so any current selection may no longer exist.
    setScope(next);
    setSelectedNodeId(null);
    setShowGalaxyZoomHint(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (openMemoryPath) {
        return;
      }

      if (event.key === "Escape") {
        setSelectedNodeId(null);
        setShowGalaxyZoomHint(false);
        setZoomLevel(0);
        canvasRef.current?.setZoomLevel(0);
      } else if (event.key === "1" || event.key === "2" || event.key === "3") {
        handleZoomLevelChange((Number(event.key) - 1) as GalacticZoomLevel);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleZoomLevelChange, openMemoryPath]);

  if (graph.isLoading) return <div className="p-6 text-sm text-text-muted">Loading graph...</div>;
  if (graph.error || !graph.data) return <div className="p-6 text-sm text-status-red">Failed to load graph.</div>;

  const hasTouchOnlyInput =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 && !hasFinePointer;
  if (isBelowMd || hasTouchOnlyInput) {
    return <GraphMobileFallback nodes={graph.data.nodes} edgeCount={graph.data.edges.length} />;
  }

  const isListView = viewMode === "list";

  return (
    <div className="relative h-[calc(100vh-3rem)] w-full overflow-hidden bg-[#050508]" data-hovered-node={hoveredNodeId ?? undefined}>
      <button
        type="button"
        aria-pressed={isListView}
        className="absolute right-4 top-4 z-40 rounded-md border border-border-subtle bg-surface/85 px-3 py-1.5 text-xs font-medium text-text-primary shadow-lg backdrop-blur transition-colors hover:border-primary hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={() => setViewMode((mode) => (mode === "graph" ? "list" : "graph"))}
      >
        {isListView ? "Graph view" : "List view"}
      </button>
      {isListView ? (
        <div className="h-full w-full overflow-y-auto">
          <GraphMobileFallback
            nodes={graph.data.nodes}
            edgeCount={graph.data.edges.length}
            onOpenMemory={setOpenMemoryPath}
          />
        </div>
      ) : (
        <>
      <GalacticScene
        ref={canvasRef}
        nodes={graph.data.nodes}
        edges={graph.data.edges}
        selectedNodeId={selectedNodeId}
        zoomLevel={zoomLevel}
        onGalaxyClusterClick={handleGalaxyClusterClick}
        onHoverNode={setHoveredNodeId}
        onSelectNode={selectNode}
        onZoomLevelChange={handleSceneZoomLevelChange}
      />
      <GraphMobileFallback
        className="sr-only"
        nodes={graph.data.nodes}
        edgeCount={graph.data.edges.length}
      />
      {showGalaxyZoomHint && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-14 z-30 -translate-x-1/2 rounded-md border border-border-subtle bg-surface/85 px-3 py-2 text-center text-xs font-medium text-text-primary shadow-lg backdrop-blur"
        >
          Zoom in to select individual memories
        </div>
      )}
      <GalacticHUD
        edges={graph.data.edges}
        nodes={graph.data.nodes}
        scope={scope}
        isUpdating={graph.isPlaceholderData}
        selectedNode={selectedNode}
        zoomLevel={zoomLevel}
        onOpenMemory={setOpenMemoryPath}
        onScopeChange={handleScopeChange}
        onSelectNode={selectNode}
        onDeselect={() => setSelectedNodeId(null)}
        onZoomLevelChange={handleZoomLevelChange}
      />
        </>
      )}
      {openMemoryPath !== null && (
        <MemoryModal
          graphNodes={graph.data.nodes}
          open
          path={openMemoryPath}
          onClose={() => setOpenMemoryPath(null)}
          onSelectNode={selectNode}
        />
      )}
    </div>
  );
}

function GraphMobileFallback({
  className = "min-h-[calc(100vh-3.5rem)] bg-[#050508] p-4",
  edgeCount,
  nodes,
  onOpenMemory,
}: {
  className?: string;
  edgeCount: number;
  nodes: GraphNode[];
  onOpenMemory?: (path: string) => void;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      const type = node.type || node.kind;
      const items = groups.get(type) ?? [];
      items.push(node);
      groups.set(type, items);
    }

    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, items]) => ({
        type,
        nodes: items
          .slice()
          .sort((left, right) => right.inboundCount - left.inboundCount || left.title.localeCompare(right.title))
          .slice(0, 12),
      }));
  }, [nodes]);

  return (
    <section aria-label="Memory knowledge graph text alternative" className={className}>
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="glass-blur rounded-lg p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Graph fallback</p>
          <h1 className="mt-2 text-xl font-semibold text-text-primary">Open on desktop for the 3D view</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Mobile and touch-only devices show a grouped node index instead of the WebGL graph. {nodes.length} nodes
            and {edgeCount} edges are available.
          </p>
        </div>

        {grouped.map((group) => (
          <section key={group.type} className="rounded-lg border border-border-subtle bg-surface p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="break-words text-base font-semibold text-text-primary">{group.type}</h2>
              <span className="flex-shrink-0 font-mono text-xs text-text-muted">{group.nodes.length}</span>
            </div>
            <ul className="space-y-2">
              {group.nodes.map((node) => {
                const meta = (
                  <>
                    <h3 className="break-words text-sm font-medium text-text-primary">{node.title}</h3>
                    <p className="mt-1 break-all font-mono text-xs text-text-muted">{node.path}</p>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
                      <span>in {node.inboundCount}</span>
                      <span>out {node.outboundCount}</span>
                      {node.confidence !== null ? <span>conf {node.confidence.toFixed(2)}</span> : null}
                    </div>
                  </>
                );
                return (
                  <li key={node.path}>
                    {onOpenMemory ? (
                      <button
                        type="button"
                        className="w-full rounded-md border border-border-subtle bg-background/40 p-3 text-left transition-colors hover:border-primary hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => onOpenMemory(node.path)}
                      >
                        {meta}
                      </button>
                    ) : (
                      <div className="rounded-md border border-border-subtle bg-background/40 p-3">{meta}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
