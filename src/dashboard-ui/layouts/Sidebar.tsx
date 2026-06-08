import { Link, useLocation } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Skeleton } from "../components/Skeleton.js";
import { StatusPill, type StatusKind } from "../components/StatusPill.js";
import { useStatus, type DashboardStatus } from "../hooks/useStatus.js";
import { useSyncState, type CheckoutSyncState } from "../hooks/useSyncState.js";
import { cn } from "../lib/cn.js";
import {
  ADVANCED_NAV_ITEMS,
  OPERATIONS_NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  type NavItem,
} from "../lib/nav-items.js";
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
  const syncState = useSyncState();
  const sidebarStatus = statusPillState(status, syncState);

  return (
    <aside
      aria-label={label}
      className={cn(
        "w-[220px] flex-shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface p-3",
        className,
      )}
    >
      <div className="px-3 py-4">
        <div className="text-lg font-semibold tracking-tight">Memory Fort</div>
        <p className="text-xs text-text-muted">v0.4.0-dev</p>
      </div>
      <nav className="flex flex-col gap-0.5" aria-label="Primary navigation">
        {PRIMARY_NAV_ITEMS.map((item) => (
          <SidebarNavLink key={item.to} item={item} pathname={location.pathname} onNavigate={onNavigate} />
        ))}
        <SidebarNavGroup
          className="mt-2 border-t border-border-subtle pt-2"
          items={OPERATIONS_NAV_ITEMS}
          label="Operations"
          onNavigate={onNavigate}
          pathname={location.pathname}
        />
        <SidebarNavGroup
          className="mt-1"
          items={ADVANCED_NAV_ITEMS}
          label="Advanced"
          onNavigate={onNavigate}
          pathname={location.pathname}
        />
      </nav>
      <div className="mt-auto px-2">
        {sidebarStatus === "loading" ? (
          <Skeleton
            aria-label="Loading sync status"
            className="h-[1.375rem] w-28 rounded-full"
            variant="line"
          />
        ) : (
          <a href={sidebarStatus.href} aria-label={sidebarStatus.ariaLabel} title={sidebarStatus.title}>
            <StatusPill kind={sidebarStatus.kind}>{sidebarStatus.label}</StatusPill>
          </a>
        )}
      </div>
    </aside>
  );
}

function SidebarNavGroup({
  className,
  items,
  label,
  onNavigate,
  pathname,
}: {
  className?: string;
  items: NavItem[];
  label: string;
  onNavigate?: () => void;
  pathname: string;
}) {
  const groupId = useId();
  const isGroupActive = items.some((item) => isActiveRoute(pathname, item.to));
  const [isOpen, setIsOpen] = useState(isGroupActive);

  useEffect(() => {
    if (isGroupActive) setIsOpen(true);
  }, [isGroupActive]);

  return (
    <div className={className}>
      <button
        type="button"
        aria-controls={groupId}
        aria-expanded={isOpen}
        className={cn(
          "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5",
          isGroupActive
            ? "bg-surface-2 text-text-primary"
            : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
        )}
        onClick={() => setIsOpen((open) => !open)}
      >
        <ChevronDown
          size={16}
          strokeWidth={1.5}
          className={cn("transition-transform", isOpen ? "rotate-0" : "-rotate-90")}
          aria-hidden
        />
        {label}
      </button>
      {isOpen ? (
        <div id={groupId} className="mt-1 flex flex-col gap-0.5">
          {items.map((item) => (
            <SidebarNavLink
              key={item.to}
              item={item}
              pathname={pathname}
              onNavigate={onNavigate}
              className="pl-8"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SidebarNavLink({
  className,
  item,
  onNavigate,
  pathname,
}: {
  className?: string;
  item: NavItem;
  onNavigate?: () => void;
  pathname: string;
}) {
  const Icon = item.icon;
  const isActive = isActiveRoute(pathname, item.to);

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={cn(
        "relative flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors md:min-h-0 md:py-1.5",
        isActive
          ? "bg-surface-2 text-text-primary"
          : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
        className,
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
}

function isActiveRoute(pathname: string, to: string): boolean {
  return pathname === to || (to !== "/" && pathname.startsWith(to));
}

type StatusQuery = ReturnType<typeof useStatus>;
type SyncStateQuery = ReturnType<typeof useSyncState>;

function statusPillState(
  status: StatusQuery,
  syncState: SyncStateQuery,
): "loading" | { kind: StatusKind; label: string; href: string; ariaLabel: string; title: string } {
  if (status.isLoading && !status.data) return "loading";
  if (status.isError || hasRecentErrorLog(status.data)) {
    return {
      kind: "error",
      label: statusLabel("error", statusTimestamp(status.data)),
      href: "/memory/audit?level=error&source=errors",
      ariaLabel: "View recent errors in the audit log",
      title: "View recent errors in the audit log",
    };
  }

  if (status.data?.errorsLog?.isClean === false) {
    return {
      kind: "synced",
      label: "healthy",
      href: "/memory/audit?level=error&source=errors",
      ariaLabel: "View historical error log entries",
      title: "No errors in the last 24 hours",
    };
  }

  if (syncState.isLoading && !syncState.data) return "loading";
  if (syncState.isError || !syncState.data) {
    return statusLink("unknown", "unknown", "/memory/");
  }

  const checkoutSyncState = syncState.data;
  if (checkoutSyncState.status !== "synced" && checkoutSyncState.status !== "stale") {
    return statusLink("unknown", "unknown", "/memory/");
  }

  const label = checkoutSyncState.status;
  return statusLink(checkoutSyncState.status, statusLabel(label, syncTimestamp(checkoutSyncState)), "/memory/");
}

function statusLink(kind: StatusKind, label: string, href: string) {
  return {
    kind,
    label,
    href,
    ariaLabel: `Open ${label} status details`,
    title: `Open ${label} status details`,
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

function syncTimestamp(syncState: CheckoutSyncState): string | null {
  return syncState.lastCheckoutAt;
}

function statusLabel(label: string, timestamp: string | null): string {
  return timestamp ? `${label} ${relativeTime(timestamp)}` : label;
}

function hasRecentErrorLog(status: DashboardStatus | undefined): boolean {
  if (status?.errorsLog?.isClean !== false) return false;
  const timestamp = parseTimestamp(status.errorsLog.lastLine);
  if (!timestamp) return false;
  return Date.now() - timestamp.getTime() < 24 * 60 * 60 * 1000;
}

function parseTimestamp(line: string | null): Date | null {
  if (!line) return null;
  const match = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (!match) return null;
  const parsed = new Date(match[0]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
