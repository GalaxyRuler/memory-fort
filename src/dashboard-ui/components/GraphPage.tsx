import { useEffect, useMemo, useRef, useState } from "react";
import { type GraphNode, useGraph } from "../hooks/useGraph.js";
import { type GraphMode, usesFixedPositions } from "../lib/graph-layouts.js";
import {
  computeOrbitalPositions,
  computeTimelineFlowPositions,
  filterByTimelineScrubber,
} from "../lib/graph-positioning.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { GraphDetailPanel } from "./GraphDetailPanel.js";
import { GraphHUD } from "./GraphHUD.js";
import { GraphTelemetry } from "./GraphTelemetry.js";
import { TimelineScrubber } from "./TimelineScrubber.js";

const DEFAULT_TYPES = new Set(["projects", "decisions", "lessons", "references", "tools", "crystal"]);

export function GraphPage() {
  const graph = useGraph("wiki");
  const [mode, setMode] = useState<GraphMode>("force");
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(DEFAULT_TYPES);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [timelineMaxAge, setTimelineMaxAge] = useState(90);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

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

  if (graph.isLoading) return <div className="p-6 text-sm text-text-muted">Loading graph...</div>;
  if (graph.error || !graph.data) return <div className="p-6 text-sm text-status-red">Failed to load graph.</div>;

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
      />
      <GraphHUD mode={mode} enabledTypes={enabledTypes} onModeChange={setMode} onToggleType={toggleType} />
      <GraphDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
      {mode === "timeline-flow" && <TimelineScrubber maxAgeDays={timelineMaxAge} onChange={setTimelineMaxAge} />}
      <GraphTelemetry
        nodeCount={graph.data.nodes.length}
        edgeCount={graph.data.edges.length}
        mode={mode}
        unresolvedCount={graph.data.unresolvedTargets.length}
      />
    </div>
  );
}
