import {
  AlertTriangle,
  Archive,
  Check,
  Clock,
  ExternalLink,
  GitBranch,
  Link,
  Loader2,
  MoreHorizontal,
  Network,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  useMaintenanceArchive,
  useMaintenanceDelete,
  useMaintenanceRecurate,
} from "../hooks/useMaintenanceActions.js";
import { type MaintenancePageSummary, useMaintenanceScan } from "../hooks/useMaintenanceScan.js";
import { Button } from "./Button.js";
import { GlassPanel } from "./GlassPanel.js";

type SectionKey = "orphans" | "lowConfidence" | "stale" | "supersededDependents" | "pruneCandidates";

interface MaintenanceSection {
  key: SectionKey;
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
  /** "delete" | "archive" | "recurate" | "navigate" */
  actionKind: "delete" | "archive" | "recurate" | "navigate";
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

/** Extract category + slug from a wiki path like "preferences/dark-mode.md" */
function wikiLink(path: string): string {
  const noExt = path.replace(/\.md$/, "");
  const slash = noExt.indexOf("/");
  if (slash === -1) return `/wiki/uncategorized/${noExt}`;
  return `/wiki/${noExt.slice(0, slash)}/${noExt.slice(slash + 1)}`;
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

function MaintenanceRow({
  page,
  section,
  onRowAction,
  actionPending,
}: {
  page: MaintenancePageSummary;
  section: MaintenanceSection;
  onRowAction: (path: string) => void;
  actionPending: boolean;
}) {
  const ActionIcon = section.actionIcon;
  const confidence = confidencePercent(page.confidence);

  return (
    <li className="grid grid-cols-1 gap-3 border-t border-border-subtle/70 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_9rem_8rem] md:items-center">
      <div className="min-w-0">
        <a
          href={wikiLink(page.path)}
          className="break-words text-sm font-medium text-text-primary underline-offset-2 hover:underline md:truncate md:block"
        >
          {page.title}
        </a>
        <p className="break-all font-mono text-xs text-text-muted">{page.path}</p>
      </div>
      <span className="break-words font-mono text-xs text-text-secondary">{page.updated ?? "unknown"}</span>
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full ${section.dotClass}`} style={{ width: `${confidence}%` }} />
        </div>
        <span className="font-mono text-xs text-text-secondary">{confidenceLabel(page.confidence)}</span>
      </div>
      {section.actionKind === "navigate" ? (
        <a
          href={wikiLink(page.path)}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2"
        >
          <ExternalLink size={14} strokeWidth={1.5} />
          {section.rowAction}
        </a>
      ) : (
        <Button
          type="button"
          onClick={() => onRowAction(page.path)}
          disabled={actionPending}
          className="justify-center"
        >
          {actionPending ? <Loader2 size={14} strokeWidth={1.5} className="animate-spin" /> : <ActionIcon size={14} strokeWidth={1.5} />}
          {section.rowAction}
        </Button>
      )}
    </li>
  );
}

function ConfirmDialog({
  title,
  description,
  count,
  onConfirm,
  onCancel,
  pending,
}: {
  title: string;
  description: string;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-lg border border-border-emphasis bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-lg font-semibold text-text-primary">{title}</h2>
        <p className="mt-3 text-sm text-text-secondary">{description}</p>
        <p className="mt-2 rounded bg-surface-2 px-3 py-2 font-mono text-xs text-text-muted">
          {count} {count === 1 ? "page" : "pages"} affected
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            <X size={15} strokeWidth={1.5} />
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 size={15} strokeWidth={1.5} className="animate-spin" /> : <Check size={15} strokeWidth={1.5} />}
            Confirm
          </Button>
        </div>
      </div>
    </div>
  );
}

function MaintenanceSectionPanel({
  section,
  onBulkAction,
  onRowAction,
  bulkPending,
  pendingPaths,
}: {
  section: MaintenanceSection;
  onBulkAction: () => void;
  onRowAction: (path: string) => void;
  bulkPending: boolean;
  pendingPaths: Set<string>;
}) {
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
            {section.actionKind === "navigate" ? (
              <span className="text-xs text-text-muted italic">Open each page to review</span>
            ) : (
              <Button
                type="button"
                onClick={onBulkAction}
                disabled={section.pages.length === 0 || bulkPending}
              >
                {bulkPending ? <Loader2 size={14} strokeWidth={1.5} className="animate-spin" /> : <ActionIcon size={14} strokeWidth={1.5} />}
                {section.bulkLabel}
              </Button>
            )}
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
                <MaintenanceRow
                  key={page.path}
                  page={page}
                  section={section}
                  onRowAction={onRowAction}
                  actionPending={pendingPaths.has(page.path)}
                />
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
  const archiveMutation = useMaintenanceArchive();
  const deleteMutation = useMaintenanceDelete();
  const recurateMutation = useMaintenanceRecurate();

  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    paths: string[];
    action: "delete" | "archive" | "recurate";
  } | null>(null);

  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());

  const data = scan.data ?? {
    orphans: [],
    lowConfidence: [],
    stale: [],
    supersededDependents: [],
    pruneCandidates: [],
  };

  function getMutationForAction(action: "delete" | "archive" | "recurate") {
    if (action === "delete") return deleteMutation;
    if (action === "archive") return archiveMutation;
    return recurateMutation;
  }

  function executeMutation(paths: string[], action: "delete" | "archive" | "recurate") {
    setPendingPaths((prev) => new Set([...prev, ...paths]));
    getMutationForAction(action).mutate(paths, {
      onSettled: () => {
        setPendingPaths((prev) => {
          const next = new Set(prev);
          for (const p of paths) next.delete(p);
          return next;
        });
        setConfirm(null);
      },
    });
  }

  function handleRowAction(sectionKey: SectionKey, path: string) {
    const action = sectionActionKind(sectionKey);
    if (action === "navigate") return;
    setConfirm({
      title: actionLabel(action),
      description: `${actionVerb(action)} "${path}"?`,
      paths: [path],
      action,
    });
  }

  function handleBulkAction(section: MaintenanceSection) {
    if (section.actionKind === "navigate") return;
    const paths = section.pages.map((p) => p.path);
    setConfirm({
      title: section.bulkLabel,
      description: `This will ${actionVerb(section.actionKind).toLowerCase()} all ${paths.length} pages in "${section.title}".`,
      paths,
      action: section.actionKind,
    });
  }

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
      rowAction: "Delete",
      helper: "CLI: memory lint and memory page",
      icon: Network,
      actionIcon: Trash2,
      actionKind: "delete",
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
      actionKind: "recurate",
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
      actionKind: "archive",
    },
    {
      key: "supersededDependents",
      title: "Superseded Dependents",
      metricLabel: "Superseded refs",
      metricHint: "need review",
      description: "Pages that still depend on superseded pages through relation chains.",
      pages: data.supersededDependents,
      colorClass: "text-status-amber",
      dotClass: "bg-status-amber",
      bulkLabel: "Review references",
      rowAction: "Review",
      helper: "CLI: memory lint",
      icon: GitBranch,
      actionIcon: ExternalLink,
      actionKind: "navigate",
    },
    {
      key: "pruneCandidates",
      title: "Ready To Prune",
      metricLabel: "Prune ready",
      metricHint: "stale + orphan + low",
      description: "Pages that are stale, orphaned, and below confidence 0.5.",
      pages: data.pruneCandidates,
      colorClass: "text-status-green",
      dotClass: "bg-status-green",
      bulkLabel: "Archive all",
      rowAction: "Archive",
      helper: "CLI: memory prune --plan",
      icon: Archive,
      actionIcon: Archive,
      actionKind: "archive",
    },
  ];

  const anyPending = archiveMutation.isPending || deleteMutation.isPending || recurateMutation.isPending;
  const lastError = archiveMutation.error ?? deleteMutation.error ?? recurateMutation.error;

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          count={confirm.paths.length}
          pending={anyPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => executeMutation(confirm.paths, confirm.action)}
        />
      )}

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
            <Button
              type="button"
              onClick={() => scan.refetch()}
              disabled={scan.isFetching}
            >
              {scan.isFetching
                ? <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                : <RotateCw size={15} strokeWidth={1.5} />}
              {scan.isFetching ? "Scanning..." : "Run Scan"}
            </Button>
          </div>
          <p className="text-xs text-text-muted">CLI: memory lint --stale-days 180</p>
        </div>
      </header>

      {scan.isLoading && <GlassPanel className="text-sm text-text-muted">Loading maintenance scan...</GlassPanel>}
      {scan.isError && <GlassPanel className="text-sm text-status-red">Failed to load maintenance scan.</GlassPanel>}

      {lastError && (
        <GlassPanel className="mb-4 border border-status-red/30 bg-status-red/10 text-sm text-status-red">
          {lastError instanceof Error ? lastError.message : "Action failed."}
        </GlassPanel>
      )}

      {!scan.isLoading && !scan.isError && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            {sections.map((section) => (
              <MetricCard key={section.key} section={section} />
            ))}
          </div>
          {sections.map((section) => (
            <div key={section.key} className="relative">
              <MaintenanceSectionPanel
                section={section}
                onBulkAction={() => handleBulkAction(section)}
                onRowAction={(path) => handleRowAction(section.key, path)}
                bulkPending={anyPending}
                pendingPaths={pendingPaths}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sectionActionKind(key: SectionKey): "delete" | "archive" | "recurate" | "navigate" {
  switch (key) {
    case "orphans": return "delete";
    case "lowConfidence": return "recurate";
    case "stale": return "archive";
    case "supersededDependents": return "navigate";
    case "pruneCandidates": return "archive";
  }
}

function actionLabel(action: "delete" | "archive" | "recurate"): string {
  switch (action) {
    case "delete": return "Delete Page";
    case "archive": return "Archive Page";
    case "recurate": return "Re-curate Page";
  }
}

function actionVerb(action: "delete" | "archive" | "recurate"): string {
  switch (action) {
    case "delete": return "Delete";
    case "archive": return "Archive";
    case "recurate": return "Mark for re-curation";
  }
}
