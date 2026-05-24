import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

export type StatusKind = "active" | "archived" | "superseded" | "draft" | "synced" | "stale" | "conflict";

const VARIANTS: Record<StatusKind, string> = {
  active: "border-status-green/30 bg-status-green/20 text-status-green",
  archived: "border-text-muted/30 bg-text-muted/20 text-text-muted",
  superseded: "border-status-amber/30 bg-status-amber/20 text-status-amber",
  draft: "border-status-amber/30 bg-status-amber/20 text-status-amber",
  synced: "border-status-green/30 bg-status-green/20 text-status-green",
  stale: "border-status-amber/30 bg-status-amber/20 text-status-amber",
  conflict: "border-status-red/30 bg-status-red/20 text-status-red",
};

export function StatusPill({ kind, children }: { kind: StatusKind; children?: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", VARIANTS[kind])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children ?? kind}
    </span>
  );
}
