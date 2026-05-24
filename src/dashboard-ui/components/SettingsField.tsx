import { Lock } from "lucide-react";
import { cn } from "../lib/cn.js";

export interface SettingsFieldProps {
  label: string;
  value: unknown;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return value.toString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => formatValue(item)).join(", ");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SettingsField({ label, value }: SettingsFieldProps) {
  const isRedacted = typeof value === "string" && value === "[REDACTED]";
  const formatted = formatValue(value);
  const isLong = formatted.length > 60;

  return (
    <div className="grid grid-cols-1 items-baseline gap-1 border-b border-border-subtle/60 py-2 last:border-b-0 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className={cn("flex items-center gap-2 text-sm", isLong && "break-all font-mono text-xs")}>
        {isRedacted && <Lock size={12} strokeWidth={1.5} className="flex-shrink-0 text-status-amber" />}
        <span className={cn(isRedacted ? "font-mono text-status-amber" : "text-text-primary")}>{formatted}</span>
      </dd>
    </div>
  );
}
