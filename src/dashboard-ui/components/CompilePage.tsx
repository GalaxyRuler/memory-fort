import { CheckCircle2, Clock, Cpu, FileText, Network, Play, Terminal } from "lucide-react";
import { type CompileLastRun, useCompileState } from "../hooks/useCompileState.js";
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

function CompileRunSummary({ lastRun }: { lastRun: CompileLastRun }) {
  return (
    <GlassPanel className="space-y-4 bg-surface/70">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Last completed run</h2>
          <p className="font-mono text-xs text-text-muted">{formatTimestamp(lastRun.finishedAt)}</p>
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

function CompileSourceNodes() {
  const nodes = ["node_38a1", "node_9b4f", "node_2c7e"];
  return (
    <div className="flex flex-col gap-4 text-sm sm:gap-5">
      {nodes.map((node) => (
        <div key={node} className="flex items-center gap-3 text-text-secondary">
          <span className="h-3 w-3 rounded-full bg-entity-raw-session shadow-[0_0_10px_rgba(82,82,91,0.7)]" />
          <span className="font-mono">{node}</span>
        </div>
      ))}
    </div>
  );
}

function CompileGraphPreview({ isRunning, hasLastRun }: { isRunning: boolean; hasLastRun: boolean }) {
  return (
    <GlassPanel className="relative min-h-[22rem] overflow-hidden bg-surface/35 p-0">
      <div
        className="absolute inset-0 opacity-25"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.16) 1px, transparent 0)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="relative z-10 grid h-full min-h-[22rem] grid-cols-1 items-center gap-8 p-6 md:grid-cols-[1fr_1.5fr]">
        <CompileSourceNodes />
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-entity-decisions/70 bg-entity-decisions/20 text-entity-decisions shadow-[0_0_24px_rgba(139,95,255,0.35)]">
            <Network size={30} strokeWidth={1.5} />
          </div>
          <div className="rounded-lg border border-border-emphasis bg-surface/80 px-5 py-3 backdrop-blur">
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
          <p key={line} className={index === 1 && isRunning ? "text-entity-decisions" : undefined}>
            <span className="mr-2 text-text-muted">[{String(index + 1).padStart(2, "0")}]</span>
            {line}
          </p>
        ))}
      </div>
    </GlassPanel>
  );
}

function CompilePagesPanel({ lastRun }: { lastRun: CompileLastRun | null }) {
  const pagesCompiled = lastRun?.pagesCompiled ?? 0;
  const percent = Math.max(0, Math.min(100, pagesCompiled === 0 ? 0 : 100));

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
        disabled
        className="mt-5 w-full justify-center disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Play size={15} strokeWidth={1.5} />
        Run compile
      </Button>
      <p className="mt-2 text-center text-xs text-text-muted">CLI: memory compile</p>
    </GlassPanel>
  );
}

export function CompilePage() {
  const compile = useCompileState();
  const state = compile.data;
  const lastRun = state?.lastRun ?? null;
  const isRunning = state?.status === "running";

  return (
    <div className="relative mx-auto min-h-[calc(100vh-5rem)] max-w-7xl overflow-hidden p-6">
      <header className="relative z-10 mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-lg border border-border-emphasis bg-surface-2 text-primary">
            <Cpu size={18} strokeWidth={1.5} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Compilation Phase</h1>
            <p className="max-w-2xl text-sm text-text-secondary">
              Read-only curation status from the local memory state. Triggering compile remains a CLI-only operation.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Button
            type="button"
            variant="primary"
            disabled
            className="disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Play size={15} strokeWidth={1.5} />
            Run compile
          </Button>
          <p className="text-xs text-text-muted">CLI: memory compile</p>
        </div>
      </header>

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
                    The dashboard is observing the current state file and will refresh while the CLI run is active.
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
            <CompilePagesPanel lastRun={lastRun} />
          </div>

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
