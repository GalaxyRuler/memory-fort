import { AlertTriangle, Archive, Check, GitBranch, GitMerge } from "lucide-react";
import { type ConflictPageSummary, type ConflictRecord, useConflicts } from "../hooks/useConflicts.js";
import { Button } from "./Button.js";
import { GlassPanel } from "./GlassPanel.js";

const REASON_LABELS: Record<ConflictRecord["reason"], string> = {
  "duplicate-title": "Duplicate title",
  contradiction: "Direct Contradiction",
  "stale-clone": "Stale clone",
};

const REASON_DESCRIPTIONS: Record<ConflictRecord["reason"], string> = {
  "duplicate-title": "Two pages appear to describe the same memory entity.",
  contradiction: "The selected pages describe conflicting facts or guidance.",
  "stale-clone": "One page appears to be an older clone of the other.",
};

function formatPageType(path: string): string {
  const withoutPrefix = path.replace(/^wiki\//, "");
  const category = withoutPrefix.split("/")[0] ?? "page";
  return category.replace(/-/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function ConflictSide({ label, page }: { label: "A" | "B"; page: ConflictPageSummary }) {
  const colorClass = label === "A" ? "bg-entity-decisions" : "bg-entity-lessons";

  return (
    <GlassPanel className="flex min-h-[28rem] flex-col gap-5 overflow-hidden bg-surface/65 p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2/60 p-4">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${colorClass}`} />
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {formatPageType(page.path)}
          </span>
          <span className="font-mono text-xs text-text-muted">Page {label}</span>
        </div>
        <span className="font-mono text-xs text-text-muted">{page.updated ?? "unknown"}</span>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div>
          <h3 className="text-xl font-semibold text-text-primary">{page.title}</h3>
          <p className="mt-1 break-all font-mono text-xs text-text-muted">{page.path}</p>
        </div>
        <div className="relative rounded-lg border border-status-red/25 bg-status-red/10 p-4">
          <span
            className={`absolute top-1/2 h-8 w-1 -translate-y-1/2 rounded-full bg-status-red ${
              label === "A" ? "-left-0.5" : "-right-0.5"
            }`}
          />
          <p className="line-clamp-6 text-sm leading-6 text-text-secondary">{page.snippet || "(no body snippet)"}</p>
        </div>
      </div>
    </GlassPanel>
  );
}

function ConflictActions({ conflict }: { conflict: ConflictRecord }) {
  const helper = `Resolve via CLI: memory curate --resolve ${conflict.id}`;

  return (
    <GlassPanel className="flex flex-col items-center gap-4 self-center bg-surface/80 text-center shadow-2xl">
      <div className="flex h-11 w-11 items-center justify-center rounded-full border border-status-red/30 bg-status-red/15 text-status-red">
        <AlertTriangle size={22} strokeWidth={1.5} />
      </div>
      <div>
        <h3 className="text-base font-semibold text-text-primary">{REASON_LABELS[conflict.reason]}</h3>
        <p className="mt-1 text-sm text-text-muted">{REASON_DESCRIPTIONS[conflict.reason]}</p>
      </div>
      <div className="h-px w-full bg-border-subtle" />
      <div className="flex w-full flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" disabled className="justify-center disabled:cursor-not-allowed disabled:opacity-45">
            <Check size={14} strokeWidth={1.5} />
            Keep A
          </Button>
          <Button type="button" disabled className="justify-center disabled:cursor-not-allowed disabled:opacity-45">
            <Check size={14} strokeWidth={1.5} />
            Keep B
          </Button>
        </div>
        <Button type="button" disabled className="justify-center disabled:cursor-not-allowed disabled:opacity-45">
          <GitMerge size={14} strokeWidth={1.5} />
          Merge (Draft New)
        </Button>
        <Button
          type="button"
          disabled
          className="justify-center border-status-red/25 bg-status-red/10 text-status-red disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Archive size={14} strokeWidth={1.5} />
          Deprecate Old
        </Button>
        <Button type="button" disabled className="justify-center disabled:cursor-not-allowed disabled:opacity-45">
          <GitBranch size={14} strokeWidth={1.5} />
          Keep as Alternatives
        </Button>
      </div>
      <p className="text-xs text-text-muted">{helper}</p>
    </GlassPanel>
  );
}

function ConflictCard({ conflict }: { conflict: ConflictRecord }) {
  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface/55 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <GitMerge size={18} strokeWidth={1.5} className="text-status-red" />
          <div>
            <h2 className="text-base font-semibold">
              <span className="rounded-full border border-status-red/25 bg-status-red/10 px-2 py-0.5 text-sm text-status-red">
                {REASON_LABELS[conflict.reason]}
              </span>
            </h2>
            <p className="text-xs text-text-muted">{REASON_DESCRIPTIONS[conflict.reason]}</p>
          </div>
        </div>
        <span className="font-mono text-xs text-text-muted">{conflict.id}</span>
      </header>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_18rem_minmax(0,1fr)]">
        <ConflictSide label="A" page={conflict.pageA} />
        <ConflictActions conflict={conflict} />
        <ConflictSide label="B" page={conflict.pageB} />
      </div>
    </div>
  );
}

export function ConflictsPage() {
  const conflicts = useConflicts();
  const items = conflicts.data?.conflicts ?? [];

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex flex-col gap-2 border-b border-border-subtle pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <GitMerge size={22} strokeWidth={1.5} className="text-text-secondary" />
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Conflict Resolution</h1>
              <span className="rounded-full border border-status-red/25 bg-status-red/10 px-2 py-0.5 font-mono text-xs text-status-red">
                {items.length} ACTIVE
              </span>
            </div>
            <p className="text-sm text-text-secondary">Read-only conflict review. Resolution stays in the CLI.</p>
          </div>
        </div>
      </header>

      {conflicts.isLoading && <GlassPanel className="text-sm text-text-muted">Loading conflicts...</GlassPanel>}
      {conflicts.isError && <GlassPanel className="text-sm text-status-red">Failed to load conflicts.</GlassPanel>}

      {!conflicts.isLoading && !conflicts.isError && items.length === 0 && (
        <GlassPanel className="py-12 text-center">
          <h2 className="text-lg font-semibold">No conflicts detected — your wiki is consistent.</h2>
        </GlassPanel>
      )}

      <div className="space-y-4">
        {items.map((conflict) => (
          <ConflictCard key={conflict.id} conflict={conflict} />
        ))}
      </div>
    </div>
  );
}
