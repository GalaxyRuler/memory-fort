import { COGNITIVE_ORDER, COGNITIVE_META, DOMAIN_ORDER, DOMAIN_META } from "../../lib/galactic/layout.js";

const SHAPES: Record<(typeof DOMAIN_ORDER)[number], string> = {
  projects: "mini-system",
  decisions: "banded rocky",
  lessons: "binary moons",
  references: "ringed giant",
  tools: "octagon",
  crystals: "faceted hex",
};

export function Legend() {
  return (
    <div className="space-y-4 text-xs">
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Cognitive Galaxies</h2>
        <div className="space-y-1.5">
          {COGNITIVE_ORDER.map((type) => (
            <LegendRow key={type} color={COGNITIVE_META[type].color} label={COGNITIVE_META[type].label} detail={`${type} memory`} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-text-primary">Domain Shapes</h2>
        <div className="space-y-1.5">
          {DOMAIN_ORDER.map((domain) => (
            <LegendRow key={domain} color={DOMAIN_META[domain].color} label={DOMAIN_META[domain].label} detail={SHAPES[domain]} />
          ))}
        </div>
      </section>
      <section className="space-y-1 border-t border-border-subtle pt-3 font-mono text-[11px] text-text-muted">
        <div>orbit pull · inbound count</div>
        <div>glow halo · confidence</div>
        <div>edge lens · relation weight</div>
        <div>particle flow · active relation</div>
      </section>
    </div>
  );
}

function LegendRow({ color, detail, label }: { color: string; detail: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="min-w-20 text-text-secondary">{label}</span>
      <span className="truncate font-mono text-[10px] text-text-muted">{detail}</span>
    </div>
  );
}
