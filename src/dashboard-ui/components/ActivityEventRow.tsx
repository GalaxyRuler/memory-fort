import { AlertCircle, AlertTriangle, FileCog, GitCommit, RefreshCw } from "lucide-react";
import { type ActivityEvent } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";
import { relativeTime } from "../lib/time-helpers.js";

const SOURCE_ICON = {
  git: GitCommit,
  compile: FileCog,
  sync: RefreshCw,
  lint: AlertTriangle,
  errors: AlertCircle,
} as const;

const SOURCE_COLOR = {
  git: "text-status-blue",
  compile: "text-entity-decisions",
  sync: "text-status-green",
  lint: "text-entity-lessons",
  errors: "text-status-red",
} as const;

const LEVEL_BORDER = {
  info: "border-border-subtle",
  warn: "border-status-amber/30",
  error: "border-status-red/30",
} as const;

export function ActivityEventRow({ event }: { event: ActivityEvent }) {
  const Icon = SOURCE_ICON[event.source] ?? GitCommit;
  return (
    <li className={cn("border rounded-md px-3 py-2.5 mb-2", LEVEL_BORDER[event.level])}>
      <div className="flex items-start gap-3">
        <Icon
          size={14}
          strokeWidth={1.5}
          className={cn("mt-0.5 flex-shrink-0", SOURCE_COLOR[event.source])}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-primary break-words">{event.summary}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-text-muted font-mono">{event.source}</span>
            <span className="text-xs text-text-muted">{relativeTime(event.timestamp)}</span>
          </div>
        </div>
      </div>
    </li>
  );
}
