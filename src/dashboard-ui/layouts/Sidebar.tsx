import { Link, useLocation } from "@tanstack/react-router";
import { Skeleton } from "../components/Skeleton.js";
import { StatusPill, type StatusKind } from "../components/StatusPill.js";
import { useStatus, type DashboardStatus } from "../hooks/useStatus.js";
import { cn } from "../lib/cn.js";
import { NAV_ITEMS } from "../lib/nav-items.js";
import { relativeTime } from "../lib/time-helpers.js";

export function Sidebar({
  className,
  label = "Primary sidebar",
  onNavigate,
}: {
  className?: string;
  label?: string;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const status = useStatus();
  const sidebarStatus = statusPillState(status);

  return (
    <aside
      aria-label={label}
      className={cn(
        "w-[220px] flex-shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface p-3",
        className,
      )}
    >
      <div className="px-3 py-4">
        <h1 className="text-lg font-semibold tracking-tight">memory</h1>
        <p className="text-xs text-text-muted">v0.4.0-dev</p>
      </div>
      <nav className="flex flex-col gap-0.5" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            location.pathname === item.to ||
            (item.to !== "/" && location.pathname.startsWith(item.to));

          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              className={cn(
                "relative flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5",
                isActive
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
              )}
            >
              {isActive && (
                <span
                  className="gradient-accent absolute bottom-1 left-0 top-1 w-[2px] rounded-r"
                  aria-hidden
                />
              )}
              <Icon size={16} strokeWidth={1.5} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto px-2">
        {sidebarStatus === "loading" ? (
          <Skeleton
            aria-label="Loading sync status"
            className="h-[1.375rem] w-28 rounded-full"
            variant="line"
          />
        ) : (
          <StatusPill kind={sidebarStatus.kind}>{sidebarStatus.label}</StatusPill>
        )}
      </div>
    </aside>
  );
}

type StatusQuery = ReturnType<typeof useStatus>;

function statusPillState(
  status: StatusQuery,
): "loading" | { kind: StatusKind; label: string } {
  if (status.isLoading && !status.data) return "loading";
  if (status.isError || status.data?.errorsLog?.isClean === false) {
    return {
      kind: "error",
      label: statusLabel("error", statusTimestamp(status.data)),
    };
  }

  if (!status.data?.syncState) {
    return { kind: "unknown", label: "unknown" };
  }

  const syncState = status.data.syncState;
  const label = syncState.isStale ? "stale" : "synced";
  return {
    kind: syncState.isStale ? "stale" : "synced",
    label: statusLabel(label, statusTimestamp(status.data)),
  };
}

function statusTimestamp(status: DashboardStatus | undefined): string | null {
  return (
    status?.syncState?.lastCheckoutAt ??
    status?.syncState?.lastSyncSuccess ??
    status?.syncState?.lastSyncAttempt ??
    status?.generatedAt ??
    null
  );
}

function statusLabel(label: string, timestamp: string | null): string {
  return timestamp ? `${label} ${relativeTime(timestamp)}` : label;
}
