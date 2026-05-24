import {
  AlertTriangle,
  Archive,
  Clock,
  Filter,
  Link,
  MoreHorizontal,
  Network,
  RefreshCw,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
import { type MaintenancePageSummary, useMaintenanceScan } from "../hooks/useMaintenanceScan.js";
import { Button } from "./Button.js";
import { GlassPanel } from "./GlassPanel.js";

interface MaintenanceSection {
  key: "orphans" | "lowConfidence" | "stale";
  title: string;
  metricLabel: string;
  metricHint: string;
  description: string;
  pages: MaintenancePageSummary[];
  colorClass: string;
  dotClass: string;
  bulkLabel: string;
  rowAction: string;
  helper: string;
  icon: LucideIcon;
  actionIcon: LucideIcon;
}

function confidenceLabel(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function averageConfidence(pages: MaintenancePageSummary[]): string {
  const scores = pages
    .map((page) => page.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (scores.length === 0) return "n/a";
  const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return average.toFixed(2);
}

function confidencePercent(value: number | null): number {
  if (value === null) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function MetricCard({ section }: { section: MaintenanceSection }) {
  const Icon = section.icon;

  return (
    <GlassPanel className="relative overflow-hidden bg-surface/70">
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent opacity-60" />
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-text-muted">
          <span className={`h-2 w-2 rounded-full ${section.dotClass}`} />
          <span className="text-xs font-semibold uppercase tracking-wide">{section.metricLabel}</span>
        </div>
        <Icon size={18} strokeWidth={1.5} className={section.colorClass} />
      </div>
      <div className="relative z-10 mt-5 flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-text-primary">{section.pages.length}</span>
        <span className="font-mono text-xs text-text-secondary">{section.metricHint}</span>
      </div>
    </GlassPanel>
  );
}

function MaintenanceRow({ page, section }: { page: MaintenancePageSummary; section: MaintenanceSection }) {
  const ActionIcon = section.actionIcon;
  const confidence = confidencePercent(page.confidence);

  return (
    <li className="grid grid-cols-1 gap-3 border-t border-border-subtle/70 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] md:items-center">
      <div className="min-w-0">
        <div className="break-words text-sm font-medium text-text-primary md:truncate">{page.title}</div>
        <p className="break-all font-mono text-xs text-text-muted">{page.path}</p>
      </div>
      <span className="break-words font-mono text-xs text-text-secondary">{page.updated ?? "unknown"}</span>
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full ${section.dotClass}`} style={{ width: `${confidence}%` }} />
        </div>
        <span className="font-mono text-xs text-text-secondary">{confidenceLabel(page.confidence)}</span>
      </div>
      <Button type="button" disabled className="justify-center disabled:cursor-not-allowed disabled:opacity-45">
        <ActionIcon size={14} strokeWidth={1.5} />
        {section.rowAction}
      </Button>
    </li>
  );
}

function MaintenanceSectionPanel({ section }: { section: MaintenanceSection }) {
  const Icon = section.icon;
  const ActionIcon = section.actionIcon;

  return (
    <section>
      <GlassPanel className="overflow-hidden p-0">
        <header className="flex flex-col gap-3 border-b border-border-subtle bg-surface/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Icon size={18} strokeWidth={1.5} className={section.colorClass} />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="break-words text-base font-semibold">{section.title}</h2>
                <span
                  className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs text-text-muted"
                  data-testid={`maintenance-count-${section.key}`}
                >
                  {section.pages.length}
                </span>
              </div>
              <p className="mt-1 text-sm text-text-secondary">{section.description}</p>
            </div>
          </div>
          <div className="flex flex-col gap-1 sm:items-end">
            <Button type="button" disabled className="disabled:cursor-not-allowed disabled:opacity-45">
              <ActionIcon size={14} strokeWidth={1.5} />
              {section.bulkLabel}
            </Button>
            <p className="break-all text-xs text-text-muted">{section.helper}</p>
          </div>
        </header>

        {section.pages.length === 0 ? (
          <p className="p-4 text-sm text-text-muted">No pages in this category.</p>
        ) : (
          <div>
            <div className="hidden grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] border-b border-border-subtle px-4 py-2 font-mono text-xs uppercase tracking-wide text-text-muted md:grid">
              <span>Page</span>
              <span>Updated</span>
              <span>Confidence</span>
              <span className="text-right">Action</span>
            </div>
            <ul>
              {section.pages.map((page) => (
                <MaintenanceRow key={page.path} page={page} section={section} />
              ))}
            </ul>
          </div>
        )}
      </GlassPanel>
    </section>
  );
}

export function MaintenancePage() {
  const scan = useMaintenanceScan();
  const data = scan.data ?? { orphans: [], lowConfidence: [], stale: [] };
  const sections: MaintenanceSection[] = [
    {
      key: "orphans",
      title: "Orphaned Nodes",
      metricLabel: "Orphaned nodes",
      metricHint: "need links",
      description: "Pages without inbound or outbound wiki links.",
      pages: data.orphans,
      colorClass: "text-entity-projects",
      dotClass: "bg-entity-projects",
      bulkLabel: "Delete all orphans",
      rowAction: "Link",
      helper: "CLI: memory lint and memory page",
      icon: Network,
      actionIcon: Link,
    },
    {
      key: "lowConfidence",
      title: "Low Confidence Drafts",
      metricLabel: "Low confidence",
      metricHint: `avg score ${averageConfidence(data.lowConfidence)}`,
      description: "Pages with front-matter confidence below 0.6.",
      pages: data.lowConfidence,
      colorClass: "text-status-red",
      dotClass: "bg-status-red",
      bulkLabel: "Re-curate all",
      rowAction: "Re-curate",
      helper: "CLI: memory curate",
      icon: AlertTriangle,
      actionIcon: RefreshCw,
    },
    {
      key: "stale",
      title: "Stale Knowledge (> 6mo)",
      metricLabel: "Stale > 6mo",
      metricHint: "need review",
      description: "Pages whose updated date is older than 180 days.",
      pages: data.stale,
      colorClass: "text-entity-raw-session",
      dotClass: "bg-entity-raw-session",
      bulkLabel: "Archive stale",
      rowAction: "Archive",
      helper: "CLI: memory lint --stale-days 180",
      icon: Clock,
      actionIcon: Archive,
    },
  ];

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-text-muted">
            <Clock size={15} strokeWidth={1.5} />
            <span>Audit</span>
            <span>/</span>
            <span className="text-text-secondary">Maintenance</span>
          </div>
          <h1 className="break-words text-2xl font-semibold tracking-tight">Maintenance & Orphanage</h1>
          <p className="max-w-2xl text-sm text-text-secondary">
            Identify disconnected concepts, review low-confidence automated drafts, and prune stale knowledge from the
            system.
          </p>
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <div className="flex gap-2">
            <Button type="button" disabled className="disabled:cursor-not-allowed disabled:opacity-45">
              <Filter size={15} strokeWidth={1.5} />
              Filter
            </Button>
            <Button type="button" disabled className="disabled:cursor-not-allowed disabled:opacity-45">
              <RotateCw size={15} strokeWidth={1.5} />
              Run Scan
            </Button>
          </div>
          <p className="text-xs text-text-muted">CLI: memory lint --stale-days 180</p>
        </div>
      </header>

      {scan.isLoading && <GlassPanel className="text-sm text-text-muted">Loading maintenance scan...</GlassPanel>}
      {scan.isError && <GlassPanel className="text-sm text-status-red">Failed to load maintenance scan.</GlassPanel>}

      {!scan.isLoading && !scan.isError && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {sections.map((section) => (
              <MetricCard key={section.key} section={section} />
            ))}
          </div>
          {sections.map((section) => (
            <div key={section.key} className="relative">
              <MaintenanceSectionPanel section={section} />
              <button
                type="button"
                disabled
                className="absolute right-3 top-3 rounded p-1 text-text-muted opacity-60 disabled:cursor-not-allowed"
                aria-label={`${section.title} actions`}
              >
                <MoreHorizontal size={16} strokeWidth={1.5} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
