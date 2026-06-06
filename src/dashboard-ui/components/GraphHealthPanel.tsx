import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, RefreshCw, XCircle } from "lucide-react";
import { GlassPanel } from "./GlassPanel.js";
import { cn } from "../lib/cn.js";
import { relativeTime } from "../lib/time-helpers.js";
import { useGraphHealth, type GraphHealthMetric, type GraphHealthStatus } from "../hooks/useGraphHealth.js";

const STATUS_ORDER: Record<GraphHealthStatus, number> = {
  fail: 0,
  warn: 1,
  pass: 2,
  "n/a": 3,
};

const STATUS_META: Record<GraphHealthStatus, {
  label: string;
  icon: typeof CheckCircle2;
  pill: string;
  dot: string;
}> = {
  fail: {
    label: "fail",
    icon: XCircle,
    pill: "border-status-red/40 bg-status-red/10 text-status-red",
    dot: "bg-status-red",
  },
  warn: {
    label: "warn",
    icon: AlertTriangle,
    pill: "border-status-amber/40 bg-status-amber/10 text-status-amber",
    dot: "bg-status-amber",
  },
  pass: {
    label: "pass",
    icon: CheckCircle2,
    pill: "border-status-green/40 bg-status-green/10 text-status-green",
    dot: "bg-status-green",
  },
  "n/a": {
    label: "n/a",
    icon: CircleDashed,
    pill: "border-text-muted/40 bg-surface-3 text-text-muted",
    dot: "bg-text-muted",
  },
};

const OVERVIEW_EXPANDED_KEY = "mf:overview:graph-health-expanded";

export function GraphHealthPanel({
  defaultExpanded = false,
  persistExpansion = true,
  detailMode = false,
}: {
  defaultExpanded?: boolean;
  persistExpansion?: boolean;
  detailMode?: boolean;
}) {
  const graphHealth = useGraphHealth();
  const [panelExpanded, setPanelExpanded] = useState(() => {
    if (!persistExpansion || typeof window === "undefined") return defaultExpanded;
    const stored = window.localStorage.getItem(OVERVIEW_EXPANDED_KEY);
    return stored === null ? defaultExpanded : stored === "true";
  });
  const [expandedMetrics, setExpandedMetrics] = useState<Record<string, boolean>>({});

  const metrics = useMemo(() => {
    return [...(graphHealth.data?.metrics ?? [])].sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.id.localeCompare(b.id),
    );
  }, [graphHealth.data?.metrics]);
  const summary = useMemo(() => summarizeMetrics(metrics), [metrics]);

  function togglePanel() {
    setPanelExpanded((current) => {
      const next = !current;
      if (persistExpansion && typeof window !== "undefined") {
        window.localStorage.setItem(OVERVIEW_EXPANDED_KEY, String(next));
      }
      return next;
    });
  }

  return (
    <GlassPanel hasBrackets={true} className="space-y-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Graph Health</h2>
          <p className="mt-1 font-mono text-xs text-text-muted">
            {graphHealth.data?.computedAt ? `Last computed: ${relativeTime(graphHealth.data.computedAt)}` : "Waiting for graph report"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Refresh graph health"
          onClick={() => void graphHealth.refetch()}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border-subtle/50 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <RefreshCw size={15} />
        </button>
      </header>

      <button
        type="button"
        aria-expanded={panelExpanded}
        onClick={togglePanel}
        className="flex w-full items-center justify-between gap-3 rounded border border-border-subtle/35 bg-surface-2/45 px-3 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <span className="font-mono text-xs text-text-primary">Graph health: {summary}</span>
        <ChevronDown size={15} className={cn("flex-shrink-0 text-text-muted transition-transform", panelExpanded && "rotate-180")} />
      </button>

      {graphHealth.isLoading ? (
        <p className="text-sm text-text-muted">Loading graph health...</p>
      ) : null}

      {graphHealth.isError ? (
        <p className="text-sm text-status-red">{graphHealth.error?.message ?? "Unable to load graph health."}</p>
      ) : null}

      {panelExpanded ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {metrics.map((metric) => (
            <MetricCard
              key={metric.id}
              metric={metric}
              expanded={Boolean(expandedMetrics[metric.id])}
              detailMode={detailMode}
              onToggle={() => setExpandedMetrics((current) => ({ ...current, [metric.id]: !current[metric.id] }))}
            />
          ))}
        </div>
      ) : null}
    </GlassPanel>
  );
}

function MetricCard({
  metric,
  expanded,
  detailMode,
  onToggle,
}: {
  metric: GraphHealthMetric;
  expanded: boolean;
  detailMode: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[metric.status];
  const Icon = meta.icon;
  const compact = metric.status === "pass" || metric.status === "n/a";
  const hasOffenders = metric.topOffenders.length > 0;
  const healthHref = `/memory/health#${metric.id}`;

  function openHealthDetails() {
    if (detailMode || typeof window === "undefined") return;
    window.location.href = healthHref;
  }

  return (
    <section
      data-testid="graph-health-card"
      data-metric-id={metric.id}
      data-health-href={healthHref}
      id={detailMode ? metric.id : undefined}
      role={detailMode ? undefined : "link"}
      tabIndex={detailMode ? undefined : 0}
      onClick={openHealthDetails}
      onKeyDown={(event) => {
        if (!detailMode && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          openHealthDetails();
        }
      }}
      className={cn(
        "rounded border border-border-subtle/30 bg-surface-2/45 px-3 py-2.5",
        !detailMode && "cursor-pointer transition-colors hover:bg-surface-2",
        metric.status === "fail" && "border-status-red/30 bg-status-red/5",
        metric.status === "warn" && "border-status-amber/30 bg-status-amber/5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className={cn("mt-1 h-2 w-2 flex-shrink-0 rounded-full", meta.dot)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-sm font-semibold text-text-primary">{metric.label}</h3>
              <span className="font-mono text-xs text-text-secondary">{formatValue(metric)}</span>
              {metric.threshold.rule ? (
                <span className="font-mono text-[11px] text-text-muted">({metric.threshold.rule})</span>
              ) : null}
            </div>
            {compact ? (
              <p className="mt-1 text-xs leading-relaxed text-text-muted">{metric.detail}</p>
            ) : (
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{metric.detail}</p>
            )}
          </div>
        </div>
        <span className={cn("flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]", meta.pill)}>
          <Icon size={12} />
          {meta.label}
        </span>
      </div>

      {detailMode && !compact && hasOffenders ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`Details for ${metric.label}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className="mt-2 flex items-center gap-1 font-mono text-[11px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronRight size={13} className={cn("transition-transform", expanded && "rotate-90")} />
          details
        </button>
      ) : null}

      {expanded && hasOffenders ? (
        <div className="mt-2 grid gap-1.5 border-t border-border-subtle/25 pt-2">
          {metric.topOffenders.map((offender, index) => (
            <div key={`${metric.id}-${index}`} className="rounded border border-border-subtle/25 bg-surface-1 px-2 py-1.5">
              <p className="break-all font-mono text-[11px] text-text-primary">{offenderLabel(offender)}</p>
              {offender.note ? (
                <p className="mt-0.5 text-xs text-text-muted">{offender.note}</p>
              ) : null}
              {offender.value !== undefined ? (
                <p className="mt-0.5 font-mono text-[10px] text-text-muted">{String(offender.value)}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function summarizeMetrics(metrics: GraphHealthMetric[]): string {
  const counts = metrics.reduce(
    (acc, metric) => {
      acc[metric.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0, "n/a": 0 } satisfies Record<GraphHealthStatus, number>,
  );
  return `${counts.pass}/${metrics.length} passing · ${counts.warn} warn · ${counts.fail} fail`;
}

function formatValue(metric: GraphHealthMetric): string {
  if (metric.value === null) return "n/a";
  const value = typeof metric.value === "number" ? formatNumber(metric.value) : metric.value;
  return metric.unit ? `${value} ${metric.unit}` : String(value);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function offenderLabel(offender: GraphHealthMetric["topOffenders"][number]): string {
  if (offender.path) return offender.path;
  if (offender.pair) return offender.pair.join(" ~ ");
  if (offender.edge) return `${offender.edge.from} -> ${offender.edge.to} (${offender.edge.type})`;
  return "offender";
}
