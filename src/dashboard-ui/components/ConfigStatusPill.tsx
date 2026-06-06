import { cn } from "../lib/cn.js";
import type { EnvVarStatus } from "../hooks/useProvidersCatalog.js";

export function ConfigStatusPill({
  status,
}: {
  status: EnvVarStatus | "checking";
}) {
  const label = status === "checking"
    ? "[checking...]"
    : status === "set"
      ? "[REDACTED — set]"
      : "[not configured]";
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-xs",
        status === "set"
          ? "border-status-green/30 bg-status-green/10 text-status-green"
          : status === "missing"
            ? "border-status-amber/30 bg-status-amber/10 text-status-amber"
            : "border-text-muted/30 bg-text-muted/10 text-text-muted",
      )}
    >
      {label}
    </span>
  );
}
