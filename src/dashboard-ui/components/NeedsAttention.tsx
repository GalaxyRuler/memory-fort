import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle, RefreshCw } from "lucide-react";
import type { ComponentType } from "react";
import type { DashboardStatus } from "../hooks/useStatus.js";
import { useSyncNow } from "../hooks/useSyncNow.js";
import { Button } from "./Button.js";
import { Card } from "./Card.js";

interface AttentionItem {
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  tone: "red" | "amber";
  title: string;
  cta?: string;
  onClick?: () => void;
}

export function NeedsAttention({ status }: { status: DashboardStatus | undefined }) {
  const navigate = useNavigate();
  const syncNow = useSyncNow();

  if (!status) {
    return (
      <Card>
        <div className="text-sm text-text-muted">Loading...</div>
      </Card>
    );
  }

  const items: AttentionItem[] = [];
  if (status.syncState?.conflictsPending && status.syncState.conflictsPending > 0) {
    items.push({
      icon: AlertCircle,
      tone: "red",
      title: `${status.syncState.conflictsPending} sync conflict${
        status.syncState.conflictsPending === 1 ? "" : "s"
      } pending`,
      cta: "Resolve",
      onClick: () => navigate({ to: "/conflicts" }),
    });
  }
  if (status.errorsLog && !status.errorsLog.isClean) {
    items.push({
      icon: AlertTriangle,
      tone: "amber",
      title: "Errors log has new entries",
      cta: "View",
      onClick: () => navigate({ to: "/audit", search: { level: "error" } }),
    });
  }
  if (items.length === 0) {
    items.push({
      icon: AlertTriangle,
      tone: "amber",
      title: "All clear",
    });
  }

  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wider text-text-muted">
        <AlertTriangle size={12} strokeWidth={1.5} />
        Needs Attention
      </h2>
      <ul className="space-y-3">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <li
              key={`${item.title}-${index}`}
              className="flex items-start gap-2.5 rounded-md border border-border-subtle p-3"
            >
              <Icon
                size={14}
                strokeWidth={1.5}
                className={item.tone === "red" ? "mt-0.5 text-status-red" : "mt-0.5 text-status-amber"}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{item.title}</p>
                {item.cta && (
                  <Button variant="ghost" className="mt-2 text-xs" onClick={item.onClick}>
                    {item.cta}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 border-t border-border-subtle pt-3">
        <Button
          variant="ghost"
          className="w-full text-xs"
          onClick={() => syncNow.mutate()}
          disabled={syncNow.isPending}
        >
          <RefreshCw size={12} className={syncNow.isPending ? "animate-spin" : ""} />
          {syncNow.isPending ? "Syncing..." : "Sync Now"}
        </Button>
        {syncNow.isSuccess && syncNow.data.ok && (
          <p className="mt-1 text-xs text-status-green">
            {syncNow.data.autoCommit?.kind === "committed"
              ? `Committed ${syncNow.data.autoCommit.filesCount} files. `
              : ""}
            {syncNow.data.sync?.actionsPerformed.length
              ? syncNow.data.sync.actionsPerformed.join(", ")
              : "Already in sync."}
          </p>
        )}
        {syncNow.isSuccess && !syncNow.data.ok && (
          <p className="mt-1 text-xs text-status-red">{syncNow.data.error}</p>
        )}
        {syncNow.isError && (
          <p className="mt-1 text-xs text-status-red">Sync failed</p>
        )}
      </div>
    </Card>
  );
}
