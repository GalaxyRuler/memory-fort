import type { GraphEdge, GraphNode } from "../../hooks/useGraph.js";
import { COGNITIVE_META, DOMAIN_META, normalizeDomain } from "../../lib/galactic/layout.js";

export interface InspectorProps {
  node: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpenMemory: (path: string) => void;
  onSelectNode: (path: string) => void;
  onClose?: () => void;
}

const STATUS_STYLES: Record<string, { border: string; bg: string; text: string }> = {
  active: { border: "border-status-green/40", bg: "bg-status-green/10", text: "text-status-green" },
  superseded: { border: "border-status-amber/40", bg: "bg-status-amber/10", text: "text-status-amber" },
  draft: { border: "border-status-red/40", bg: "bg-status-red/10", text: "text-status-red" },
  archived: { border: "border-text-muted/40", bg: "bg-text-muted/10", text: "text-text-muted" },
};

export function Inspector({ edges, node, nodes, onClose, onOpenMemory, onSelectNode }: InspectorProps) {
  if (!node) return null;

  const domain = normalizeDomain(node);
  const outbound = edges.filter((edge) => edge.fromPath === node.path).map((edge) => nodeByPath(nodes, edge.toPath));
  const inbound = edges.filter((edge) => edge.toPath === node.path).map((edge) => nodeByPath(nodes, edge.fromPath));
  const mass = Math.min(1, node.inboundCount / 16);
  const statusStyle = STATUS_STYLES[node.status] ?? STATUS_STYLES.active;
  const confidencePct = Math.round((node.confidence ?? 0) * 100);
  const isDraft = (node.confidence ?? 0) < 0.5;

  return (
    <div className="space-y-4 text-[13px] leading-relaxed text-text-secondary">
      <header>
        <div className="mb-1 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
            {COGNITIVE_META[node.cognitiveType].label} · {DOMAIN_META[domain].label}
          </p>
          {onClose && (
            <button
              type="button"
              aria-label="Close inspector"
              onClick={onClose}
              className="-mr-1 -mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
            >
              ✕
            </button>
          )}
        </div>
        <div className="mb-2 flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-[17px] font-semibold leading-tight text-text-primary">
            {node.title}
          </h2>
          <span
            className={`flex-shrink-0 rounded border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] ${statusStyle.border} ${statusStyle.bg} ${statusStyle.text}`}
          >
            {node.status}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill color={COGNITIVE_META[node.cognitiveType].color}>{COGNITIVE_META[node.cognitiveType].label}</Pill>
          <Pill color={DOMAIN_META[domain].color}>{DOMAIN_META[domain].label}</Pill>
        </div>
      </header>

      <section>
        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-gradient-to-r from-status-green to-amber-500 transition-all duration-300"
            style={{ width: `${confidencePct}%` }}
          />
        </div>
        <p className="mt-1 font-mono text-[10px] text-text-muted">
          confidence {confidencePct}%{isDraft && " · ⚠ DRAFT"}
        </p>
      </section>

      {node.description && (
        <p className="max-h-32 overflow-auto border-l-2 border-border-subtle pl-3 text-[13px] leading-relaxed text-text-primary">
          {node.description}
        </p>
      )}

      <section>
        <SectionTitle>Metadata</SectionTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
          <Meta label="source" value={node.source} />
          <Meta label="created" value={node.created ?? "—"} />
          <Meta label="updated" value={node.updated ?? "—"} />
          <Meta label="inbound" value={String(node.inboundCount)} />
          <Meta label="outbound" value={String(node.outboundCount)} />
          <Meta label="id" value={node.path} muted />
        </dl>
      </section>

      {node.tags.length > 0 && (
        <section>
          <SectionTitle>Tags</SectionTitle>
          <div className="flex flex-wrap gap-1">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-amber-500/30 bg-amber-500/8 px-1.5 py-0.5 font-mono text-[10px] text-amber-400"
              >
                #{tag}
              </span>
            ))}
          </div>
        </section>
      )}

      <RelationList direction="out" nodes={outbound} onSelectNode={onSelectNode} title="References →" />
      <RelationList direction="in" nodes={inbound} onSelectNode={onSelectNode} title="← Referenced by" />

      <div className="rounded border border-border-subtle bg-background/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-text-muted">
        <span className="text-text-secondary">mass</span> {mass.toFixed(2)}
        <span className="mx-1.5">·</span>
        <span className="text-text-secondary">pull→core</span> {Math.round(mass * 0.5 * 100)}%
        <span className="mx-1.5">·</span>
        <span className="text-text-secondary">galaxy</span> {COGNITIVE_META[node.cognitiveType].label}
        <span className="mx-1.5">·</span>
        <span className="text-text-secondary">system</span> {DOMAIN_META[domain].label}
      </div>

      <button
        type="button"
        className="w-full rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-amber-400 transition-colors hover:border-amber-500/60 hover:bg-amber-500/20"
        onClick={() => onOpenMemory(node.path)}
      >
        ▸ Open Memory
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="mb-2 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted">{children}</h3>
  );
}

function Pill({ children, color }: { children: string; color: string }) {
  return (
    <span
      className="rounded border px-2 py-0.5 font-mono text-[10px] font-medium"
      style={{ borderColor: `${color}66`, color, backgroundColor: `${color}1a` }}
    >
      {children}
    </span>
  );
}

function Meta({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <>
      <dt className="text-[9px] uppercase tracking-[0.06em] text-text-muted">{label}</dt>
      <dd className={`truncate ${muted ? "text-text-muted" : "text-text-primary"}`}>{value}</dd>
    </>
  );
}

function RelationList({
  direction,
  nodes,
  onSelectNode,
  title,
}: {
  direction: "in" | "out";
  nodes: GraphNode[];
  onSelectNode: (path: string) => void;
  title: string;
}) {
  return (
    <section>
      <h3 className="mb-1 font-mono text-[9px] uppercase tracking-[0.2em] text-text-muted">
        {title} <span className="ml-1 text-text-ghost">· {nodes.length}</span>
      </h3>
      <div className="space-y-1">
        {nodes.length === 0 ? (
          <div className="font-mono text-[10px] text-text-muted">none</div>
        ) : (
          nodes.map((item) => (
            <button
              key={`${direction}:${item.path}`}
              type="button"
              className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[11px] text-text-secondary transition-colors hover:bg-cyan-500/8 hover:text-cyan-400"
              onClick={() => onSelectNode(item.path)}
            >
              <span className="mr-1.5 text-text-muted">{direction === "out" ? "→" : "←"}</span>
              {item.title}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function nodeByPath(nodes: GraphNode[], path: string): GraphNode {
  return nodes.find((node) => node.path === path) ?? {
    path,
    title: path,
    kind: "wiki",
    type: "references",
    cognitiveType: "semantic",
    status: "active",
    source: "unknown",
    created: null,
    confidence: null,
    tags: [],
    description: "",
    updated: null,
    inboundCount: 0,
    outboundCount: 0,
  };
}
