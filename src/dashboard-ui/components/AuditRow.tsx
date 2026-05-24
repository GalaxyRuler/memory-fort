import { type ActivityEvent } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";

const LEVEL_COLOR = {
  info: "text-status-green",
  warn: "text-status-amber",
  error: "text-status-red",
} as const;

export function AuditRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border-subtle bg-background/30 px-3 py-3 font-mono text-xs last:border-b md:flex-row md:items-baseline md:gap-3 md:rounded-none md:border-0 md:border-b md:border-border-subtle/40 md:bg-transparent md:px-0 md:py-1.5 md:last:border-b-0">
      <span className="flex-shrink-0 text-text-muted">
        {new Date(event.timestamp).toISOString().replace("T", " ").slice(0, 19)}
      </span>
      <span className={cn("flex-shrink-0 uppercase tracking-wider md:w-12 md:text-right", LEVEL_COLOR[event.level])}>
        {event.level}
      </span>
      <span className="flex-shrink-0 text-text-muted md:w-16">{event.source}</span>
      <span className="break-all text-text-primary">{event.summary}</span>
    </li>
  );
}
