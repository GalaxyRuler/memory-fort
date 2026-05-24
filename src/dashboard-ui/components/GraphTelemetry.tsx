import { type GraphMode } from "../lib/graph-layouts.js";

export interface GraphTelemetryProps {
  nodeCount: number;
  edgeCount: number;
  mode: GraphMode;
  unresolvedCount: number;
}

export function GraphTelemetry({ nodeCount, edgeCount, mode, unresolvedCount }: GraphTelemetryProps) {
  return (
    <div className="glass-blur absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full px-4 py-1.5 font-mono text-[10px] text-text-muted">
      <span>
        <span className="text-text-primary">{nodeCount}</span> nodes
      </span>
      <span className="opacity-50">/</span>
      <span>
        <span className="text-text-primary">{edgeCount}</span> edges
      </span>
      <span className="opacity-50">/</span>
      <span className="text-text-primary">{mode}</span>
      {unresolvedCount > 0 && (
        <>
          <span className="opacity-50">/</span>
          <span className="text-status-amber">{unresolvedCount} unresolved</span>
        </>
      )}
    </div>
  );
}
