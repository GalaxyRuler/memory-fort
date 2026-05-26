import type { GraphEdge, GraphNode } from "../../hooks/useGraph.js";
import { COGNITIVE_META, DOMAIN_META, normalizeDomain } from "../../lib/galactic/layout.js";

export interface InspectorProps {
  node: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  onOpenMemory: (path: string) => void;
  onSelectNode: (path: string) => void;
}

export function Inspector({ edges, node, nodes, onOpenMemory, onSelectNode }: InspectorProps) {
  if (!node) return null;

  const domain = normalizeDomain(node);
  const outbound = edges.filter((edge) => edge.fromPath === node.path).map((edge) => nodeByPath(nodes, edge.toPath));
  const inbound = edges.filter((edge) => edge.toPath === node.path).map((edge) => nodeByPath(nodes, edge.fromPath));
  const mass = Math.min(1, node.inboundCount / 16);

  return (
    <div className="space-y-4 text-xs text-text-secondary">
      <header>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              {COGNITIVE_META[node.cognitiveType].label} / {DOMAIN_META[domain].label}
            </p>
            <h2 className="break-words text-base font-semibold text-text-primary">{node.title}</h2>
          </div>
          <span className="flex-shrink-0 rounded border border-status-green/40 bg-status-green/10 px-2 py-0.5 font-mono text-[10px] uppercase text-status-green">
            {node.status}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill color={COGNITIVE_META[node.cognitiveType].color}>{COGNITIVE_META[node.cognitiveType].label}</Pill>
          <Pill color={DOMAIN_META[domain].color}>{DOMAIN_META[domain].label}</Pill>
        </div>
      </header>

      <section>
        <div className="mb-1 flex items-center justify-between font-mono text-[11px] text-text-muted">
          <span>confidence {Math.round((node.confidence ?? 0) * 100)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-surface-3">
          <div className="h-full rounded bg-primary" style={{ width: `${Math.round((node.confidence ?? 0) * 100)}%` }} />
        </div>
      </section>

      <p className="max-h-24 overflow-auto text-sm leading-5 text-text-secondary">{node.description || "No description available."}</p>

      <dl className="grid grid-cols-2 gap-2 rounded border border-border-subtle bg-background/30 p-3 font-mono text-[11px]">
        <Meta label="source" value={node.source} />
        <Meta label="created" value={node.created ?? "-"} />
        <Meta label="updated" value={node.updated ?? "-"} />
        <Meta label="inbound" value={String(node.inboundCount)} />
        <Meta label="outbound" value={String(node.outboundCount)} />
        <Meta label="id" value={node.path} wide />
      </dl>

      {node.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {node.tags.map((tag) => (
            <span key={tag} className="rounded border border-border-subtle bg-surface/70 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
              #{tag}
            </span>
          ))}
        </div>
      )}

      <RelationList direction="out" nodes={outbound} onSelectNode={onSelectNode} title="References ->" />
      <RelationList direction="in" nodes={inbound} onSelectNode={onSelectNode} title="<- Referenced by" />

      <div className="rounded border border-border-subtle bg-surface/50 p-2 font-mono text-[11px] text-text-muted">
        mass {mass.toFixed(2)} - pull to core {Math.round(mass * 0.5 * 100)}% - galaxy {COGNITIVE_META[node.cognitiveType].label} - system {DOMAIN_META[domain].label}
      </div>

      <button
        type="button"
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
        onClick={() => onOpenMemory(node.path)}
      >
        Open Memory
      </button>
    </div>
  );
}

function Pill({ children, color }: { children: string; color: string }) {
  return (
    <span className="rounded border px-2 py-0.5 font-mono text-[10px]" style={{ borderColor: color, color, backgroundColor: `${color}20` }}>
      {children}
    </span>
  );
}

function Meta({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <dt className="text-text-muted">{label}</dt>
      <dd className="truncate text-text-primary">{value}</dd>
    </div>
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
      <h3 className="mb-1 font-mono text-[11px] uppercase tracking-wider text-text-muted">
        {title} <span className="text-text-ghost">{nodes.length}</span>
      </h3>
      <div className="space-y-1">
        {nodes.length === 0 ? (
          <div className="rounded border border-border-subtle bg-background/30 px-2 py-1 font-mono text-[11px] text-text-muted">none</div>
        ) : (
          nodes.map((item) => (
            <button
              key={`${direction}:${item.path}`}
              type="button"
              className="block w-full truncate rounded border border-border-subtle bg-background/30 px-2 py-1 text-left text-xs text-text-secondary transition-colors hover:border-primary/40 hover:text-text-primary"
              onClick={() => onSelectNode(item.path)}
            >
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
