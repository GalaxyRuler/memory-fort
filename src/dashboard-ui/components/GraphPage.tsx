import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GraphNode, useGraph } from "../hooks/useGraph.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { type GraphMode, usesFixedPositions } from "../lib/graph-layouts.js";
import { shortestPath, twoHopNeighborhood } from "../lib/graph-pathfind.js";
import {
  computeOrbitalPositions,
  computeTimelineFlowPositions,
  filterByTimelineScrubber,
} from "../lib/graph-positioning.js";
import { matchGraphNodes } from "../lib/graph-search.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { GraphDetailPanel } from "./GraphDetailPanel.js";
import { GraphHUD } from "./GraphHUD.js";
import { GraphTelemetry } from "./GraphTelemetry.js";
import { TimelineScrubber } from "./TimelineScrubber.js";

const DEFAULT_TYPES = new Set(["projects", "decisions", "lessons", "references", "tools", "crystal"]);
const CONTEXT_MENU_WIDTH = 224;
const CONTEXT_MENU_HEIGHT = 216;

interface TracePathSet {
  nodes: Set<string>;
  edges: Set<string>;
}

interface ContextMenuState {
  node: GraphNode;
  x: number;
  y: number;
  notice: string | null;
}

export function GraphPage() {
  const graph = useGraph("wiki");
  const isBelowMd = useMediaQuery("(max-width: 767px)");
  const hasFinePointer = useMediaQuery("(pointer: fine)", true);
  const [mode, setMode] = useState<GraphMode>("force");
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [timelineMaxAge, setTimelineMaxAge] = useState(90);
  const [searchQuery, setSearchQuery] = useState("");
  const [traceSource, setTraceSource] = useState<GraphNode | null>(null);
  const [tracePathSet, setTracePathSet] = useState<TracePathSet | null>(null);
  const [focusModeOrigin, setFocusModeOrigin] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Initialize to near-correct dimensions so ForceGraph3D's first render
  // isn't stuck at a wrong size while waiting for the ResizeObserver callback.
  const [size, setSize] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 800,
    height: typeof window !== "undefined" ? window.innerHeight - 48 : 600,
  }));

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const toggleType = (type: string) => {
    setEnabledTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const fixedPositions = useMemo(() => {
    if (!graph.data || !usesFixedPositions(mode)) return undefined;
    if (mode === "orbital") {
      return computeOrbitalPositions(graph.data.nodes, graph.data.edges, selectedNode?.path ?? null);
    }
    if (mode === "timeline-flow") {
      return computeTimelineFlowPositions(graph.data.nodes);
    }
    return undefined;
  }, [graph.data, mode, selectedNode?.path]);

  const visiblePaths = useMemo(() => {
    if (mode !== "timeline-flow" || !graph.data) return undefined;
    return filterByTimelineScrubber(graph.data.nodes, timelineMaxAge);
  }, [graph.data, mode, timelineMaxAge]);

  const searchMatches = useMemo(() => matchGraphNodes(graph.data?.nodes ?? [], searchQuery), [graph.data?.nodes, searchQuery]);

  const focusPaths = useMemo(() => {
    if (!graph.data || !focusModeOrigin) return new Set<string>();
    return twoHopNeighborhood(graph.data.edges, focusModeOrigin);
  }, [focusModeOrigin, graph.data]);

  const matchedPaths = useMemo(() => {
    const paths = new Set(searchMatches);
    for (const path of focusPaths) paths.add(path);
    return paths;
  }, [focusPaths, searchMatches]);

  const focusModeNode = useMemo(() => {
    if (!graph.data || !focusModeOrigin) return null;
    return graph.data.nodes.find((node) => node.path === focusModeOrigin) ?? null;
  }, [focusModeOrigin, graph.data]);

  const handleNodeRightClick = useCallback((node: GraphNode, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = clamp(event.clientX - rect.left, 8, rect.width - CONTEXT_MENU_WIDTH - 8);
    const y = clamp(event.clientY - rect.top, 8, rect.height - CONTEXT_MENU_HEIGHT - 8);
    setContextMenu({ node, x, y, notice: null });
  }, []);

  const handleSetTraceSource = useCallback(() => {
    if (!contextMenu) return;
    setTraceSource(contextMenu.node);
    setContextMenu(null);
  }, [contextMenu]);

  const handleTraceToNode = useCallback(() => {
    if (!contextMenu || !traceSource || !graph.data || contextMenu.node.path === traceSource.path) return;

    const path = shortestPath(graph.data.edges, traceSource.path, contextMenu.node.path);
    if (!path) {
      setContextMenu((current) => (current ? { ...current, notice: "No path found." } : current));
      return;
    }

    setTracePathSet({
      nodes: new Set(path.nodes),
      edges: new Set(path.edgePairs.map(([fromPath, toPath]) => graphEdgeKey(fromPath, toPath))),
    });
    setContextMenu(null);
  }, [contextMenu, graph.data, traceSource]);

  const handleClearTrace = useCallback(() => {
    setTraceSource(null);
    setTracePathSet(null);
    setContextMenu(null);
  }, []);

  const handleToggleFocusMode = useCallback(() => {
    if (!contextMenu) return;
    setFocusModeOrigin((current) => (current === contextMenu.node.path ? null : contextMenu.node.path));
    setContextMenu(null);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [contextMenu]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
      setTraceSource(null);
      setTracePathSet(null);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (graph.isLoading) return <div className="p-6 text-sm text-text-muted">Loading graph...</div>;
  if (graph.error || !graph.data) return <div className="p-6 text-sm text-status-red">Failed to load graph.</div>;

  const hasTouchOnlyInput =
    typeof navigator !== "undefined" && navigator.maxTouchPoints > 0 && !hasFinePointer;
  if (isBelowMd || hasTouchOnlyInput) {
    return <GraphMobileFallback nodes={graph.data.nodes} edgeCount={graph.data.edges.length} />;
  }

  const canTraceToContextNode = Boolean(traceSource && contextMenu && traceSource.path !== contextMenu.node.path);
  const focusModeLabel = focusModeNode?.title ?? focusModeOrigin;

  return (
    <div className="relative h-[calc(100vh-3rem)] w-full bg-[#050508]" ref={containerRef}>
      <GraphCanvas
        nodes={graph.data.nodes}
        edges={graph.data.edges}
        mode={mode}
        enabledTypes={enabledTypes}
        onNodeClick={setSelectedNode}
        width={size.width}
        height={size.height}
        fixedPositions={fixedPositions}
        visiblePaths={visiblePaths}
        matchedPaths={matchedPaths}
        tracePathSet={tracePathSet}
        onNodeRightClick={handleNodeRightClick}
      />
      <GraphHUD
        mode={mode}
        enabledTypes={enabledTypes}
        searchQuery={searchQuery}
        searchMatchCount={searchQuery.trim() ? searchMatches.size : 0}
        focusModeLabel={focusModeLabel}
        onModeChange={setMode}
        onSearchChange={setSearchQuery}
        onToggleType={toggleType}
        onClearFocusMode={() => setFocusModeOrigin(null)}
      />
      <GraphDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
      {mode === "timeline-flow" && <TimelineScrubber maxAgeDays={timelineMaxAge} onChange={setTimelineMaxAge} />}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="glass-blur absolute z-30 w-56 rounded-lg border border-border-subtle p-2 text-xs text-text-secondary shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="border-b border-border-subtle px-2 pb-2">
            <div className="truncate font-mono text-[11px] text-text-primary">{contextMenu.node.title}</div>
            {traceSource && <div className="mt-0.5 truncate text-[10px] text-text-muted">Source: {traceSource.title}</div>}
          </div>
          <div className="mt-1 space-y-1">
            <GraphContextMenuButton onClick={handleSetTraceSource}>Set as trace source</GraphContextMenuButton>
            <GraphContextMenuButton disabled={!canTraceToContextNode} onClick={handleTraceToNode}>
              Trace path to...
            </GraphContextMenuButton>
            <GraphContextMenuButton disabled={!traceSource && !tracePathSet} onClick={handleClearTrace}>
              Clear trace
            </GraphContextMenuButton>
            <GraphContextMenuButton onClick={handleToggleFocusMode}>
              {focusModeOrigin === contextMenu.node.path ? "Clear focus mode (2-hop)" : "Focus mode (2-hop)"}
            </GraphContextMenuButton>
          </div>
          {contextMenu.notice && <div className="mt-2 rounded border border-status-amber/40 px-2 py-1 text-status-amber">{contextMenu.notice}</div>}
        </div>
      )}
      <GraphTelemetry
        nodeCount={graph.data.nodes.length}
        edgeCount={graph.data.edges.length}
        mode={mode}
        unresolvedCount={graph.data.unresolvedTargets.length}
      />
    </div>
  );
}

function GraphContextMenuButton({
  children,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-surface-2 enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function GraphMobileFallback({ edgeCount, nodes }: { edgeCount: number; nodes: GraphNode[] }) {
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
    <div className="min-h-[calc(100vh-3.5rem)] bg-[#050508] p-4">
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
              {group.nodes.map((node) => (
                <li key={node.path} className="rounded-md border border-border-subtle bg-background/40 p-3">
                  <h3 className="break-words text-sm font-medium text-text-primary">{node.title}</h3>
                  <p className="mt-1 break-all font-mono text-xs text-text-muted">{node.path}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-muted">
                    <span>in {node.inboundCount}</span>
                    <span>out {node.outboundCount}</span>
                    {node.confidence !== null ? <span>conf {node.confidence.toFixed(2)}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function graphEdgeKey(fromPath: string, toPath: string): string {
  return `${fromPath}\u0000${toPath}`;
}
