import { type ActivityEvent } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";

const LEVEL_COLOR = {
  info: "text-status-green",
  warn: "text-status-amber",
  error: "text-status-red",
} as const;

export function AuditRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="flex items-baseline gap-3 border-b border-border-subtle/40 py-1.5 font-mono text-xs last:border-b-0">
      <span className="flex-shrink-0 text-text-muted">
        {new Date(event.timestamp).toISOString().replace("T", " ").slice(0, 19)}
      </span>
      <span className={cn("w-12 flex-shrink-0 text-right uppercase tracking-wider", LEVEL_COLOR[event.level])}>
        {event.level}
      </span>
      <span className="w-16 flex-shrink-0 text-text-muted">{event.source}</span>
      <span className="break-all text-text-primary">{event.summary}</span>
    </li>
  );
}
