import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { type GraphNode } from "../hooks/useGraph.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { nodeColor } from "../lib/graph-colors.js";
import { wikiPathToRouterParams } from "../lib/wikilinks.js";
import { BottomSheet } from "./BottomSheet.js";

export interface GraphDetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

export function GraphDetailPanel({ node, onClose }: GraphDetailPanelProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");

  if (!node) return null;

  const color = nodeColor(node);
  const routerParams = wikiPathToRouterParams(node.path);

  if (isMobile) {
    return (
      <BottomSheet isOpen={true} onClose={onClose} title={node.title}>
        <GraphNodeDetails color={color} node={node} routerParams={routerParams} />
      </BottomSheet>
    );
  }

  return (
    <div className="glass-blur absolute right-4 top-4 z-10 w-72 rounded-lg p-4">
      <div className="mb-3 flex items-start justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{node.type || node.kind}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close detail panel" className="text-text-muted hover:text-text-primary">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <h3 className="mb-1 break-words text-base font-semibold text-text-primary">{node.title}</h3>
      <p className="mb-3 break-all font-mono text-xs text-text-muted">{node.path}</p>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-text-muted">In</dt>
          <dd className="font-mono">{node.inboundCount}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Out</dt>
          <dd className="font-mono">{node.outboundCount}</dd>
        </div>
        {node.confidence !== null && (
          <div>
            <dt className="text-text-muted">Conf</dt>
            <dd className="font-mono">{node.confidence.toFixed(2)}</dd>
          </div>
        )}
        {node.updated && (
          <div>
            <dt className="text-text-muted">Updated</dt>
            <dd className="font-mono">{node.updated}</dd>
          </div>
        )}
      </dl>

      {routerParams && (
        <Link
          to="/wiki/$category/$slug"
          params={routerParams}
          className="mt-4 block rounded-md bg-primary px-3 py-1.5 text-center text-xs text-background transition-opacity hover:opacity-90"
        >
          Open page
        </Link>
      )}
    </div>
  );
}

function GraphNodeDetails({
  color,
  node,
  routerParams,
}: {
  color: string;
  node: GraphNode;
  routerParams: { category: string; slug: string } | null;
}) {
  return (
    <div>
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{node.type || node.kind}</span>
      </div>

      <p className="mb-3 break-all font-mono text-xs text-text-muted">{node.path}</p>

      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-text-muted">In</dt>
          <dd className="font-mono">{node.inboundCount}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Out</dt>
          <dd className="font-mono">{node.outboundCount}</dd>
        </div>
        {node.confidence !== null && (
          <div>
            <dt className="text-text-muted">Conf</dt>
            <dd className="font-mono">{node.confidence.toFixed(2)}</dd>
          </div>
        )}
        {node.updated && (
          <div>
            <dt className="text-text-muted">Updated</dt>
            <dd className="font-mono">{node.updated}</dd>
          </div>
        )}
      </dl>

      {routerParams && (
        <Link
          to="/wiki/$category/$slug"
          params={routerParams}
          className="mt-4 block min-h-11 rounded-md bg-primary px-3 py-3 text-center text-xs text-background transition-opacity hover:opacity-90"
        >
          Open page
        </Link>
      )}
    </div>
  );
}
