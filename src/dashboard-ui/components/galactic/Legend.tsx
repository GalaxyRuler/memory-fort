import { COGNITIVE_ORDER, COGNITIVE_META, DOMAIN_ORDER, DOMAIN_META, normalizeDomain } from "../../lib/galactic/layout.js";
import type { GraphNode } from "../../hooks/useGraph.js";

const COGNITIVE_DEFINITIONS: Partial<Record<(typeof COGNITIVE_ORDER)[number], string>> = {
  episodic: "memories tied to specific events or sessions",
  procedural: "repeatable know-how for workflows and habits",
};

const DOMAIN_DEFINITIONS: Partial<Record<(typeof DOMAIN_ORDER)[number], string>> = {
  crystals: "curated digests distilled from completed work",
};

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
        <h2 className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Cognitive Galaxies</h2>
        <p className="mb-2 text-[11px] text-text-muted">memory groups arranged by how they are used</p>
        <div className="space-y-1.5">
          {COGNITIVE_ORDER.map((type) => (
            <LegendRow
              key={type}
              color={COGNITIVE_META[type].color}
              count={cognitiveCounts[type]}
              label={COGNITIVE_META[type].label}
              detail={COGNITIVE_DEFINITIONS[type] ?? `${type} memory`}
            />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Domain Colors</h2>
        <div className="space-y-1.5">
          {DOMAIN_ORDER.map((domain) => (
            <LegendRow
              key={domain}
              color={DOMAIN_META[domain].color}
              count={domainCounts[domain]}
              label={DOMAIN_META[domain].label}
              detail={DOMAIN_DEFINITIONS[domain]}
            />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Physics · data-driven</h2>
        <div className="space-y-1.5">
          <PhysicsRow label="orbit motion" detail="ambient animation" />
          <PhysicsRow label="planet size" detail="inbound count" />
          <PhysicsRow label="edge color" detail="domain gradient" />
          <PhysicsRow label="edge opacity" detail="cross-galaxy = dim" />
        </div>
      </section>
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

function LegendRow({ color, count, detail, label }: { color: string; count: number; detail?: string; label: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(5rem,auto)_1fr_auto] items-center gap-2">
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="min-w-20 text-text-secondary">{label}</span>
      <span className="min-w-0 font-mono text-[10px] leading-snug text-text-muted">{detail ?? ""}</span>
      <span
        aria-label={`${label} count`}
        className={`min-w-6 text-right font-mono text-[10px] ${count === 0 ? "text-text-ghost" : "text-text-muted"}`}
      >
        {count}
      </span>
    </div>
  );
}
