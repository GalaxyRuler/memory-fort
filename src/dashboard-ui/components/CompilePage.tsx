import { useState } from "react";
import { CheckCircle2, Clock, Cpu, FileText, Network, Play, Terminal } from "lucide-react";
import { type CompileLastRun, type CompileRunResponse, useCompileState, useRunCompileNow } from "../hooks/useCompileState.js";
import { useStatus } from "../hooks/useStatus.js";
import { Button } from "./Button.js";
import { GlassPanel } from "./GlassPanel.js";
import { StatusPill } from "./StatusPill.js";

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function CompileResultSummary({ response }: { response: CompileRunResponse }) {
  const summary = response.summary;
  if (!summary.execute) {
    return (
      <GlassPanel className="border-primary/30 bg-primary/5 text-sm text-text-secondary">
        Prompt generated from {formatNumber(summary.rawIncluded)} raw observations; {formatNumber(summary.rawSkipped)} skipped.
        <span className="ml-1 break-all font-mono text-text-primary">{summary.outputPath}</span>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel className="space-y-3 border-primary/30 bg-primary/5 text-sm text-text-secondary">
      <p>
        Consolidated {formatNumber(summary.rawIncluded)} observations {"->"}{" "}
        <strong className="text-text-primary">{formatNumber(summary.opsApplied)} applied</strong>,{" "}
        <strong className="text-text-primary">{formatNumber(summary.opsStaged)} staged for review</strong>,{" "}
        <strong className={summary.opsRejected > 0 ? "text-status-red" : "text-text-primary"}>
          {formatNumber(summary.opsRejected)} rejected
        </strong>.
      </p>
      <p>
        <strong className="text-text-primary">{formatNumber(summary.rawRemaining)} observations remaining</strong>
        {summary.rawRemaining > 0 ? " - run again to continue." : "."}
        {summary.referencesStripped > 0 ? ` ${formatNumber(summary.referencesStripped)} invented references stripped.` : ""}
      </p>
      {summary.opsStaged > 0 ? (
        <a className="inline-flex text-primary hover:underline" href="/memory/inbox">
          Review {formatNumber(summary.opsStaged)} staged changes {"->"}
        </a>
      ) : null}
      {summary.outcomes.length > 0 ? (
        <ul className="space-y-1 border-t border-border-subtle pt-3">
          {summary.outcomes.map((item, index) => (
            <li key={`${item.path}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={item.outcome === "rejected" ? "font-medium text-status-red" : "font-medium text-text-primary"}>
                {item.outcome}
              </span>
              <span className="break-all font-mono text-xs text-text-secondary">{item.path}</span>
              {item.reason ? <span className="text-xs text-text-muted">({item.reason})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {summary.error ? <p className="text-status-red">{summary.error}</p> : null}
    </GlassPanel>
  );
}

function CompileConfirmDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="compile-confirm-title"
        className="w-full max-w-lg rounded-lg border border-border-emphasis bg-surface p-5 shadow-xl"
      >
        <h2 id="compile-confirm-title" className="text-lg font-semibold text-text-primary">Run compile?</h2>
        <p className="mt-3 text-sm text-text-secondary">
          This sends recent raw observations to the LLM and updates your wiki: high-confidence changes are written
          directly; low-confidence ones go to the Inbox for review. This modifies canonical memory.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="button" variant="primary" onClick={onConfirm}>Run compile</Button>
        </div>
      </div>
    </div>
  );
}

function CompileRunSummary({ lastRun }: { lastRun: CompileLastRun }) {
  return (
    <GlassPanel className="space-y-4 bg-surface/70">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Last completed run</h2>
          <p className="break-words font-mono text-xs text-text-muted">{formatTimestamp(lastRun.finishedAt)}</p>
        </div>
        <StatusPill kind="synced">completed</StatusPill>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border-subtle bg-surface/60 p-3">
          <dt className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
            <Clock size={14} strokeWidth={1.5} />
            Duration
          </dt>
          <dd className="font-mono text-sm text-text-primary">{formatDuration(lastRun.durationMs)}</dd>
        </div>
        <div className="rounded-lg border border-border-subtle bg-surface/60 p-3">
          <dt className="mb-1 text-xs text-text-muted">Pages compiled</dt>
          <dd className="font-mono text-sm text-text-primary">{lastRun.pagesCompiled}</dd>
        </div>
        <div className="rounded-lg border border-border-subtle bg-surface/60 p-3 sm:col-span-2">
          <dt className="mb-1 flex items-center gap-1.5 text-xs text-text-muted">
            <FileText size={14} strokeWidth={1.5} />
            Output digest
          </dt>
          <dd className="break-all font-mono text-sm text-text-primary">{lastRun.digestPath}</dd>
        </div>
      </dl>
    </GlassPanel>
  );
}

function CompileGraphPreview({ isRunning, hasLastRun }: { isRunning: boolean; hasLastRun: boolean }) {
  return (
    <GlassPanel className="relative min-h-[18rem] overflow-hidden bg-surface/35 p-0 md:min-h-[22rem]">
      <div
        className="absolute inset-0 opacity-25"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.16) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="relative z-10 flex h-full min-h-[18rem] items-center justify-center p-4 md:min-h-[22rem] md:p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-entity-decisions/70 bg-entity-decisions/20 text-entity-decisions shadow-[0_0_24px_rgba(139,95,255,0.35)]">
            <Network size={30} strokeWidth={1.5} />
          </div>
          <div className="rounded-lg border border-border-emphasis bg-surface/80 px-4 py-3 backdrop-blur md:px-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-entity-decisions">
              {isRunning ? "Synthesizing graph" : hasLastRun ? "Digest ready" : "Awaiting compile"}
            </p>
            <p className="mt-1 text-lg font-semibold text-text-primary">
              {hasLastRun ? "Curated Memory Digest" : "Run memory compile"}
            </p>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}

function CompileLogPanel({ isRunning, lastRun }: { isRunning: boolean; lastRun: CompileLastRun | null }) {
  const finished = lastRun?.finishedAt ? formatTimestamp(lastRun.finishedAt) : null;
  const lines = isRunning
    ? [
        "Parsing session history...",
        "Identifying common semantic threads.",
        "Synthesizing wiki clusters.",
        "Forming memory graph edges.",
      ]
    : lastRun
      ? [
          `Completed ${lastRun.pagesCompiled} pages.`,
          `Wrote digest to ${lastRun.digestPath}.`,
          `Finished ${finished ?? lastRun.finishedAt}.`,
        ]
      : ["No compiler log recorded.", "Run memory compile from the CLI."];

  return (
    <GlassPanel className="bg-surface/70">
      <div className="mb-3 flex items-center justify-between border-b border-border-subtle pb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Compiler Log</span>
        <StatusPill kind={isRunning ? "stale" : lastRun ? "synced" : "archived"}>
          {isRunning ? "running" : lastRun ? "completed" : "idle"}
        </StatusPill>
      </div>
      <div className="space-y-2 font-mono text-sm text-text-secondary">
        {lines.map((line, index) => (
            <p key={line} className={index === 1 && isRunning ? "break-all text-entity-decisions" : "break-all"}>
            <span className="mr-2 text-text-muted">[{String(index + 1).padStart(2, "0")}]</span>
            {line}
          </p>
        ))}
      </div>
    </GlassPanel>
  );
}

function CompilePagesPanel({
  disabledReason,
  isRunning,
  lastRun,
  onRun,
}: {
  disabledReason: string | null;
  isRunning: boolean;
  lastRun: CompileLastRun | null;
  onRun: () => void;
}) {
  const pagesCompiled = lastRun?.pagesCompiled ?? 0;
  const percent = Math.max(0, Math.min(100, pagesCompiled === 0 ? 0 : 100));
  const disabled = isRunning || disabledReason !== null;

  return (
    <GlassPanel className="flex flex-col justify-between bg-surface/70">
      <div>
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">Pages compiled</span>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-3xl font-semibold text-text-primary">{pagesCompiled}</span>
          <span className="mb-1 text-sm text-text-secondary">pages</span>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-entity-decisions" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <Button
        type="button"
        variant="primary"
        disabled={disabled}
        title={disabledReason ?? undefined}
        onClick={onRun}
        className="mt-5 w-full justify-center disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Play size={15} strokeWidth={1.5} />
        {isRunning ? "Consolidating..." : "Run compile now"}
      </Button>
    </GlassPanel>
  );
}

export function CompilePage() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<"execute" | "artifact" | null>(null);
  const compile = useCompileState();
  const status = useStatus();
  const runCompile = useRunCompileNow();
  const state = compile.data;
  const lastRun = state?.lastRun ?? null;
  const isRunning = state?.status === "running" || runCompile.isPending;
  const schedule = state?.schedule;
  const readOnlyReason = status.data?.capabilities?.writable === false
    ? status.data.capabilities.reason ?? "vault is read-only"
    : null;
  const capabilityLoadingReason = status.isLoading ? "Checking dashboard write capability..." : null;
  const executeDisabledReason = capabilityLoadingReason
    ?? readOnlyReason
    ?? (state?.execute?.available === false ? state.execute.reason ?? "LLM execution is unavailable" : null);
  const primaryDisabled = isRunning || executeDisabledReason !== null;
  const runningLabel = pendingMode === "artifact" ? "Generating prompt..." : "Consolidating...";
  const errorMessage = runCompile.error?.message ?? null;

  function confirmRunCompile() {
    setConfirmOpen(false);
    setPendingMode("execute");
    runCompile.mutate({ execute: true });
  }

  function generatePromptOnly() {
    setPendingMode("artifact");
    runCompile.mutate({ execute: false });
  }

  return (
    <div className="relative mx-auto min-h-[calc(100vh-5rem)] max-w-7xl overflow-hidden p-4 md:p-6">
      {confirmOpen ? <CompileConfirmDialog onCancel={() => setConfirmOpen(false)} onConfirm={confirmRunCompile} /> : null}
      <header className="relative z-10 mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-lg border border-border-emphasis bg-surface-2 text-primary">
            <Cpu size={18} strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="break-words text-2xl font-semibold tracking-tight">Compilation Phase</h1>
            <p className="max-w-2xl text-sm text-text-secondary">
              Curation status from the local memory state with scheduler cadence and manual compile controls.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Button
            type="button"
            variant="primary"
            disabled={primaryDisabled}
            title={executeDisabledReason ?? undefined}
            onClick={() => setConfirmOpen(true)}
            className="disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Play size={15} strokeWidth={1.5} />
            {isRunning ? runningLabel : "Run compile now"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={isRunning}
            onClick={generatePromptOnly}
            className="disabled:cursor-not-allowed disabled:opacity-45"
          >
            Generate prompt only
          </Button>
          {schedule ? (
            <p className="text-xs text-text-muted">
              {schedule.scheduled ? `Scheduled ${schedule.cadence}` : "Scheduling off"}
              {schedule.nextRunAt ? ` · next ${formatTimestamp(schedule.nextRunAt)}` : ""}
            </p>
          ) : null}
        </div>
      </header>

      {readOnlyReason ? (
        <div className="relative z-10 mb-4 rounded-md border border-status-amber/30 bg-status-amber/10 p-3 text-sm text-status-amber">
          {readOnlyReason}
        </div>
      ) : null}

      {compile.isLoading && <GlassPanel className="text-sm text-text-muted">Loading compile state...</GlassPanel>}
      {compile.isError && <GlassPanel className="text-sm text-status-red">Failed to load compile state.</GlassPanel>}

      {!compile.isLoading && !compile.isError && (
        <div className="relative z-10 space-y-4">
          {isRunning && (
            <GlassPanel className="border-primary/30 bg-primary/5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-base font-semibold text-primary">
                    <Terminal size={16} strokeWidth={1.5} />
                    Compile in progress
                  </h2>
                  <p className="text-sm text-text-secondary">
                    The dashboard is observing the current state file and will refresh while the compile run is active.
                  </p>
                </div>
                <StatusPill kind="stale">running</StatusPill>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full w-2/3 rounded-full bg-primary" />
              </div>
            </GlassPanel>
          )}

          <CompileGraphPreview isRunning={isRunning} hasLastRun={lastRun !== null} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <CompileLogPanel isRunning={isRunning} lastRun={lastRun} />
            <CompilePagesPanel
              lastRun={lastRun}
              isRunning={isRunning}
              disabledReason={executeDisabledReason}
              onRun={() => setConfirmOpen(true)}
            />
          </div>

          {runCompile.data ? <CompileResultSummary response={runCompile.data} /> : null}
          {errorMessage ? (
            <GlassPanel className="border-status-red/30 bg-status-red/5 text-sm text-status-red">
              {errorMessage.includes("already running") ? "A compile is already running." : errorMessage}
            </GlassPanel>
          ) : null}

          {lastRun ? <CompileRunSummary lastRun={lastRun} /> : null}

          {!lastRun && !isRunning ? (
            <GlassPanel className="flex items-start gap-3 bg-surface/70">
              <CheckCircle2 size={18} strokeWidth={1.5} className="mt-0.5 text-text-muted" />
              <div>
                <h2 className="mb-1 text-base font-semibold">No compile run recorded</h2>
                <p className="text-sm text-text-secondary">
                  The consolidated wiki digest will appear here after a CLI compile run records state.
                </p>
              </div>
            </GlassPanel>
          ) : null}
        </div>
      )}
    </div>
  );
}
