import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clipboard, HelpCircle, XCircle } from "lucide-react";
import { GlassPanel } from "./GlassPanel.js";
import { cn } from "../lib/cn.js";
import { useHealth, type CheckResult, type CheckStatus } from "../hooks/useHealth.js";

const STATUS_META: Record<CheckStatus, {
  label: string;
  icon: typeof CheckCircle2;
  pill: string;
  dot: string;
}> = {
  pass: {
    label: "pass",
    icon: CheckCircle2,
    pill: "border-status-green/40 bg-status-green/10 text-status-green",
    dot: "bg-status-green",
  },
  warn: {
    label: "warning",
    icon: AlertTriangle,
    pill: "border-status-amber/40 bg-status-amber/10 text-status-amber",
    dot: "bg-status-amber",
  },
  fail: {
    label: "failure",
    icon: XCircle,
    pill: "border-status-red/40 bg-status-red/10 text-status-red",
    dot: "bg-status-red",
  },
};

const INITIAL_HEALTH_TIMEOUT_MS = 10_000;

const UNKNOWN_HEALTH_CHECK: CheckResult = {
  id: "verify.report.missing",
  label: "Verify report is missing",
  status: "warn",
  detail: "No memory verify report is available yet.",
  suggestedFix: "memory verify",
  durationMs: 0,
};

export function HealthBadge() {
  const health = useHealth();
  const [expanded, setExpanded] = useState(() =>
    typeof window !== "undefined" && window.location.hash === "#memory-health",
  );
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const report = health.data;
  const isWaitingForInitialReport = health.isLoading && !report;
  const showUnknownHealth = isWaitingForInitialReport && loadingTimedOut;

  useEffect(() => {
    const expandFromHash = () => {
      if (window.location.hash === "#memory-health") setExpanded(true);
    };

    expandFromHash();
    window.addEventListener("hashchange", expandFromHash);
    return () => window.removeEventListener("hashchange", expandFromHash);
  }, []);

  useEffect(() => {
    if (!isWaitingForInitialReport) {
      setLoadingTimedOut(false);
      return;
    }

    const timeout = window.setTimeout(() => setLoadingTimedOut(true), INITIAL_HEALTH_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [isWaitingForInitialReport]);

  const counts = useMemo(() => {
    const checks = report?.checks ?? [];
    return {
      pass: checks.filter((check) => check.status === "pass").length,
      warn: checks.filter((check) => check.status === "warn").length,
      fail: checks.filter((check) => check.status === "fail").length,
      total: checks.length,
    };
  }, [report]);

  const status = health.isError ? "fail" : report?.overallStatus ?? "warn";
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  const summary = showUnknownHealth
    ? "Health status unknown — run memory verify to check"
    : health.isLoading
      ? "Checking memory health"
      : health.isError
        ? "Health check unavailable"
        : status === "pass"
          ? "All systems connected"
          : status === "fail"
            ? "Health needs attention"
            : "Health has warnings";
  const detail = showUnknownHealth
    ? "run memory verify"
    : counts.total > 0
      ? plural(counts.total, "check")
      : "waiting for verify report";
  const visibleChecks = showUnknownHealth ? [UNKNOWN_HEALTH_CHECK] : report?.checks ?? [];

  return (
    <GlassPanel id="memory-health" hasBrackets={true} className="p-0">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label="Memory health"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg border", meta.pill)}>
            <Icon size={18} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-text-primary">{summary}</span>
              {status === "warn" && counts.warn > 0 && counts.fail === 0 ? (
                <span className="rounded border border-status-amber/40 px-2 py-0.5 font-mono text-[11px] text-status-amber">
                  {plural(counts.warn, "warning")}
                </span>
              ) : null}
              {counts.fail > 0 ? (
                <span className="rounded border border-status-red/40 px-2 py-0.5 font-mono text-[11px] text-status-red">
                  {plural(counts.fail, "failure")}
                </span>
              ) : null}
              {counts.warn > 0 && counts.fail > 0 ? (
                <span className="rounded border border-status-amber/40 px-2 py-0.5 font-mono text-[11px] text-status-amber">
                  {plural(counts.warn, "warning")}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 font-mono text-xs text-text-muted">
              {detail}
            </p>
          </div>
        </div>
        <span className="font-mono text-xs text-text-muted">
          {expanded ? "hide" : "details"}
        </span>
      </button>

      {expanded ? (
        <div className="border-t border-border-subtle/30 px-4 pb-4 pt-3">
          {health.isError ? (
            <p className="text-sm text-status-red">{health.error?.message ?? "Unable to load health report."}</p>
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {visibleChecks.map((check) => (
                <HealthCheckRow key={check.id} check={check} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </GlassPanel>
  );
}

function HealthCheckRow({ check }: { check: CheckResult }) {
  const meta = STATUS_META[check.status];
  const Icon = meta.icon;
  return (
    <div className="rounded border border-border-subtle/30 bg-surface-2/50 p-3">
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 h-2 w-2 flex-shrink-0 rounded-full", meta.dot)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-medium text-text-primary">{check.label}</p>
            <span className={cn("flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px]", meta.pill)}>
              <Icon size={12} />
              {meta.label}
            </span>
          </div>
          {check.detail ? (
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{check.detail}</p>
          ) : null}
          {check.suggestedFix && check.status !== "pass" ? (
            <div className="mt-2 flex items-center gap-2">
              <HelpCircle size={13} className="flex-shrink-0 text-text-muted" />
              <code className="min-w-0 flex-1 overflow-x-auto rounded border border-border-subtle/30 bg-surface-1 px-2 py-1 font-mono text-[11px] text-text-primary">
                {check.suggestedFix}
              </code>
              <button
                type="button"
                className="rounded border border-border-subtle/40 p-1 text-text-muted hover:text-text-primary"
                aria-label={`Copy fix for ${check.label}`}
                onClick={() => void navigator.clipboard?.writeText(check.suggestedFix ?? "")}
              >
                <Clipboard size={13} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
