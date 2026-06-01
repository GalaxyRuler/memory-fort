import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { type GraphNode } from "../hooks/useGraph.js";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import {
  getConfidenceScore,
  getLifecycle,
} from "../lib/confidence.js";
import type { ConfidenceVector } from "../../storage/frontmatter.js";
import { nodeColor } from "../lib/graph-colors.js";
import { formatRelative } from "../lib/relative-time.js";
import { wikiPathToRouterParams } from "../lib/wikilinks.js";
import { BottomSheet } from "./BottomSheet.js";
import { TrustBadge } from "./TrustBadge.js";

export interface GraphDetailPanelProps {
  node: GraphNode | null;
  onClose: () => void;
}

export function GraphDetailPanel({ node, onClose }: GraphDetailPanelProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!node || isMobile) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusable = getFocusableElements(panelRef.current);
    const firstFocusable = focusable[0] ?? panelRef.current;
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;
      const focusableElements = getFocusableElements(panelRef.current);
      if (focusableElements.length === 0) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isMobile, node, onClose]);

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
    <div
      aria-labelledby={titleId}
      aria-modal="false"
      className="glass-blur absolute right-4 top-4 z-10 w-72 rounded-lg p-4"
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
    >
      <div className="mb-3 flex items-start justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{node.type || node.kind}</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close detail panel" className="text-text-muted hover:text-text-primary">
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>

      <h3 id={titleId} className="mb-1 break-words text-base font-semibold text-text-primary">
        {node.title}
      </h3>
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
        {node.updated && (
          <div>
            <dt className="text-text-muted">Updated</dt>
            <dd className="font-mono">{node.updated}</dd>
          </div>
        )}
      </dl>

      <TrustSummary node={node} />

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

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
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
        {node.updated && (
          <div>
            <dt className="text-text-muted">Updated</dt>
            <dd className="font-mono">{node.updated}</dd>
          </div>
        )}
      </dl>

      <TrustSummary node={node} />

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

function TrustSummary({ node }: { node: GraphNode }) {
  const confidenceValue = node.confidenceFull ?? node.confidence ?? undefined;
  const vector = isConfidenceVector(confidenceValue) ? confidenceValue : null;
  const confidenceScore =
    confidenceValue === undefined ? null : getConfidenceScore(confidenceValue);
  const lifecycle = getLifecycle(
    {
      confidence: confidenceValue,
      lifecycle: node.lifecycle ?? undefined,
    },
    node.path,
  );

  return (
    <section className="mt-4 border-t border-border-subtle/70 pt-3">
      <h4 className="mb-2 text-xs font-semibold text-text-primary">Trust</h4>
      <dl className="space-y-1.5 text-xs">
        {confidenceScore !== null && (
          <TrustRow label="Score">
            <span className="font-mono">{confidenceScore.toFixed(2)}</span>
          </TrustRow>
        )}
        {vector?.validation && (
          <TrustRow label="Validation">
            <TrustBadge kind="validation" value={vector.validation} />
          </TrustRow>
        )}
        {typeof vector?.source === "number" && (
          <TrustRow label="Source">
            <span className="font-mono">
              {node.source} ({vector.source.toFixed(2)})
            </span>
          </TrustRow>
        )}
        {vector?.freshness && (
          <TrustRow label="Freshness">
            <span className="font-mono">{formatRelative(vector.freshness)}</span>
          </TrustRow>
        )}
        {typeof vector?.conflict === "string" && vector.conflict.length > 0 && (
          <TrustRow label="Conflict">
            <span className="break-all font-mono">{vector.conflict}</span>
          </TrustRow>
        )}
        <TrustRow label="Lifecycle">
          <TrustBadge kind="lifecycle" value={lifecycle} />
        </TrustRow>
        <TrustRow label="Status">
          <span className="font-mono uppercase">{node.status}</span>
        </TrustRow>
      </dl>
    </section>
  );
}

function TrustRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 text-text-secondary">{children}</dd>
    </div>
  );
}

function isConfidenceVector(
  value: GraphNode["confidenceFull"] | GraphNode["confidence"] | undefined,
): value is ConfidenceVector {
  return typeof value === "object" && value !== null;
}
