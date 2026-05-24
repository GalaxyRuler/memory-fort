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
    <Card className="sticky top-4 space-y-4">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Source</h3>
        <div className="space-y-1">
          {SOURCES.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => onChange({ source: item.value })}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-sm transition-colors",
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
                "flex-1 px-2 py-1 rounded-md text-xs transition-colors",
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
