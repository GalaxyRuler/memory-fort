import { type HTMLAttributes } from "react";
import { AlertCircle, AlertTriangle, Bot, Braces, Code, FileCog, GitCommit, MessageSquare, MonitorSmartphone, Puzzle, RefreshCw } from "lucide-react";
import { type ActivityEvent } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";
import { relativeTime } from "../lib/time-helpers.js";

const SOURCE_ICON: Record<ActivityEvent["source"], typeof GitCommit> = {
  git: GitCommit,
  compile: FileCog,
  sync: RefreshCw,
  lint: AlertTriangle,
  errors: AlertCircle,
  "claude-code": Bot,
  codex: Braces,
  antigravity: MonitorSmartphone,
  "claude-desktop": Bot,
  chatgpt: MessageSquare,
  opencode: Code,
  opencoven: Puzzle,
  vscode: Code,
  manual: FileCog,
};

const SOURCE_COLOR: Record<ActivityEvent["source"], string> = {
  git: "text-status-blue",
  compile: "text-entity-decisions",
  sync: "text-status-green",
  lint: "text-entity-lessons",
  errors: "text-status-red",
  "claude-code": "text-[#8b5fff]",
  codex: "text-[#5b8bff]",
  antigravity: "text-[#cebdff]",
  "claude-desktop": "text-[#c084fc]",
  chatgpt: "text-[#10a37f]",
  opencode: "text-[#f97316]",
  opencoven: "text-[#e879f9]",
  vscode: "text-[#007acc]",
  manual: "text-[#94a3b8]",
};

const LEVEL_BORDER = {
  info: "border-border-subtle",
  warn: "border-status-amber/30",
  error: "border-status-red/30",
} as const;

export function ActivityEventRow({
  event,
  keyboardProps,
}: {
  event: ActivityEvent;
  keyboardProps?: HTMLAttributes<HTMLLIElement>;
}) {
  const Icon = SOURCE_ICON[event.source];
  return (
    <li
      className={cn(
        "border rounded-md px-3 py-2.5 mb-2 data-[focused=true]:bg-surface-2 data-[focused=true]:ring-1 data-[focused=true]:ring-primary/60",
        LEVEL_BORDER[event.level],
      )}
      {...keyboardProps}
    >
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
