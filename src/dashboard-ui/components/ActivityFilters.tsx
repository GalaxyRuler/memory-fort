import { type ActivityEvent } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";

const SOURCES: Array<{ value: ActivityEvent["source"] | "all"; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "git", label: "Git" },
  { value: "compile", label: "Compile" },
  { value: "sync", label: "Sync" },
  { value: "lint", label: "Lint" },
  { value: "errors", label: "Errors" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "antigravity", label: "Antigravity" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "hermes", label: "Hermes" },
  { value: "pi", label: "Pi" },
  { value: "openclaw", label: "OpenClaw" },
  { value: "opencode", label: "OpenCode" },
  { value: "opencoven", label: "OpenCoven" },
  { value: "vscode", label: "VS Code" },
  { value: "manual", label: "Manual" },
];

const LEVELS: Array<{ value: ActivityEvent["level"] | "all"; label: string }> = [
  { value: "all", label: "All levels" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

export interface ActivityFiltersProps {
  source: ActivityEvent["source"] | "all";
  level: ActivityEvent["level"] | "all";
  onChange: (next: { source?: ActivityEvent["source"] | "all"; level?: ActivityEvent["level"] | "all" }) => void;
}

export function ActivityFilters({ source, level, onChange }: ActivityFiltersProps) {
  return (
    <Card className="space-y-4 md:sticky md:top-4">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Source</h3>
        <div className="space-y-1">
          {SOURCES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange({ source: item.value })}
              className={cn(
                "min-h-11 w-full rounded-md px-2 py-2 text-left text-sm transition-colors md:min-h-8 md:py-1",
                source === item.value
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-2/50",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Level</h3>
        <div className="flex gap-1">
          {LEVELS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange({ level: item.value })}
              className={cn(
                "min-h-11 flex-1 rounded-md px-2 py-1 text-xs transition-colors md:min-h-8",
                level === item.value
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-2/50",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}
