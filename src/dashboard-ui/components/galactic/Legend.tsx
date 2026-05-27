import { COGNITIVE_ORDER, COGNITIVE_META, DOMAIN_ORDER, DOMAIN_META, normalizeDomain } from "../../lib/galactic/layout.js";
import type { GraphNode } from "../../hooks/useGraph.js";

const SHAPES: Record<(typeof DOMAIN_ORDER)[number], string> = {
  projects: "mini-system",
  decisions: "banded rocky",
  lessons: "binary moons",
  references: "ringed giant",
  tools: "octagon",
  crystals: "faceted hex",
};

const EDGE_TYPE_LEGEND = [
  { label: "Mentions", detail: "default link", color: "rgb(165, 243, 252)", dash: "solid" },
  { label: "Supports", detail: "reinforces", color: "rgb(110, 231, 183)", dash: "solid" },
  { label: "Contradicts", detail: "conflicts", color: "rgb(252, 165, 165)", dash: "dashed" },
  { label: "Supersedes", detail: "replaces", color: "rgb(156, 163, 175)", dash: "solid", arrow: true },
  { label: "Derived From", detail: "lineage", color: "rgb(165, 180, 252)", dash: "dotted" },
  { label: "Uses / Depends On", detail: "dependency", color: "rgb(253, 224, 71)", dash: "solid" },
  { label: "Caused / Fixed By", detail: "causality", color: "rgb(196, 181, 253)", dash: "solid" },
] as const;

export function Legend({ nodes }: { nodes: GraphNode[] }) {
  const cognitiveCounts = Object.fromEntries(
    COGNITIVE_ORDER.map((type) => [type, nodes.filter((node) => node.cognitiveType === type).length]),
  ) as Record<(typeof COGNITIVE_ORDER)[number], number>;
  const domainCounts = Object.fromEntries(
    DOMAIN_ORDER.map((domain) => [domain, nodes.filter((node) => normalizeDomain(node) === domain).length]),
  ) as Record<(typeof DOMAIN_ORDER)[number], number>;

  return (
    <div className="space-y-4 text-xs">
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Cognitive Galaxies</h2>
        <div className="space-y-1.5">
          {COGNITIVE_ORDER.map((type) => (
            <LegendRow
              key={type}
              color={COGNITIVE_META[type].color}
              count={cognitiveCounts[type]}
              label={COGNITIVE_META[type].label}
              detail={`${type} memory`}
            />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Domain Shapes</h2>
        <div className="space-y-1.5">
          {DOMAIN_ORDER.map((domain) => (
            <LegendRow
              key={domain}
              color={DOMAIN_META[domain].color}
              count={domainCounts[domain]}
              label={DOMAIN_META[domain].label}
              detail={SHAPES[domain]}
            />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Edge Types</h2>
        <div className="space-y-1.5">
          {EDGE_TYPE_LEGEND.map((edge) => <EdgeTypeRow key={edge.label} {...edge} />)}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Physics · data-driven</h2>
        <div className="space-y-1.5">
          <PhysicsRow label="orbit pull" detail="inbound count" />
          <PhysicsRow label="planet size" detail="inbound count" />
          <PhysicsRow label="glow halo" detail="confidence" />
          <PhysicsRow label="edge warp" detail="relation weight" />
          <PhysicsRow label="particle flow" detail="active relation" />
        </div>
      </section>
    </div>
  );
}

function EdgeTypeRow({
  arrow,
  color,
  dash,
  detail,
  label,
}: {
  arrow?: boolean;
  color: string;
  dash: "solid" | "dashed" | "dotted";
  detail: string;
  label: string;
}) {
  const borderStyle = dash === "dotted" ? "dotted" : dash === "dashed" ? "dashed" : "solid";
  return (
    <div className="grid grid-cols-[auto_minmax(7.5rem,auto)_1fr] items-center gap-2">
      <span className="relative block h-2.5 w-6 flex-shrink-0" aria-hidden="true">
        <span
          className="absolute left-0 right-0 top-1/2 block -translate-y-1/2 border-t-2"
          style={{ borderColor: color, borderStyle }}
        />
        {arrow && (
          <span
            className="absolute right-0 top-1/2 block h-2 w-2 -translate-y-1/2 rotate-45 border-r-2 border-t-2"
            style={{ borderColor: color }}
          />
        )}
      </span>
      <span className="text-text-secondary">{label}</span>
      <span className="truncate font-mono text-[10px] text-text-muted">{detail}</span>
    </div>
  );
}

function PhysicsRow({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(5rem,auto)_1fr] items-center gap-2">
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
      <span className="text-text-secondary">{label}</span>
      <span className="truncate font-mono text-[10px] text-text-muted">{detail}</span>
    </div>
  );
}

function LegendRow({ color, count, detail, label }: { color: string; count: number; detail: string; label: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(5rem,auto)_1fr_auto] items-center gap-2">
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="min-w-20 text-text-secondary">{label}</span>
      <span className="truncate font-mono text-[10px] text-text-muted">{detail}</span>
      <span
        aria-label={`${label} count`}
        className={`min-w-6 text-right font-mono text-[10px] ${count === 0 ? "text-text-ghost" : "text-text-muted"}`}
      >
        {count}
      </span>
    </div>
  );
}
