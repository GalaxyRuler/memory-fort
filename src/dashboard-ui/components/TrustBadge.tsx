import { cn } from "../lib/cn.js";
import type { LifecycleStage, ValidationState } from "../../storage/frontmatter.js";

const VALIDATION_STYLES: Record<ValidationState, string> = {
  user: "border-status-green/40 bg-status-green/10 text-status-green",
  auto: "border-status-blue/40 bg-status-blue/10 text-status-blue",
  unvalidated: "border-text-muted/40 bg-surface-3 text-text-muted",
  challenged: "border-status-amber/40 bg-status-amber/10 text-status-amber",
  revoked: "border-status-red/40 bg-status-red/10 text-status-red",
};

const LIFECYCLE_STYLES: Record<LifecycleStage, string> = {
  canonical: "border-status-green/40 bg-status-green/10 text-status-green",
  consolidated: "border-cyan-400/40 bg-cyan-400/10 text-cyan-400",
  proposed: "border-status-blue/40 bg-status-blue/10 text-status-blue",
  observed: "border-text-muted/40 bg-surface-3 text-text-muted",
  linked: "border-text-muted/40 bg-surface-3 text-text-muted",
  stale: "border-status-amber/40 bg-status-amber/10 text-status-amber",
  disputed: "border-orange-400/40 bg-orange-400/10 text-orange-400",
  dormant: "border-violet-400/40 bg-violet-400/10 text-violet-400",
  archived: "border-status-red/40 bg-status-red/10 text-status-red",
};

export function TrustBadge({
  kind,
  value,
}: {
  kind: "validation";
  value: ValidationState;
} | {
  kind: "lifecycle";
  value: LifecycleStage;
}) {
  const style = kind === "validation"
    ? VALIDATION_STYLES[value]
    : LIFECYCLE_STYLES[value];

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-none",
        style,
      )}
    >
      {value.toUpperCase()}
    </span>
  );
}
