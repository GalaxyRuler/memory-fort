import { type RawSource } from "../lib/raw-helpers.js";
import { Card } from "./Card.js";
import { cn } from "../lib/cn.js";

const SOURCES: { value: RawSource | "all"; label: string }[] = [
  { value: "all", label: "All tools" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "antigravity", label: "Antigravity" },
  { value: "claude-desktop", label: "Claude Desktop" },
  { value: "manual", label: "Manual" },
];

export interface RawFiltersProps {
  source: RawSource | "all";
  onChange: (source: RawSource | "all") => void;
}

export function RawFilters({ source, onChange }: RawFiltersProps) {
  return (
    <Card className="md:sticky md:top-4">
      <h3 className="text-xs uppercase tracking-wider text-text-muted mb-2">Tool</h3>
      <div className="space-y-1">
        {SOURCES.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => onChange(item.value)}
            className={cn(
              "min-h-11 w-full rounded-md px-2 py-2 text-left text-sm transition-colors md:min-h-8 md:py-1.5",
              source === item.value
                ? "bg-surface-2 text-text-primary"
                : "text-text-secondary hover:text-text-primary hover:bg-surface-2/50",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
    </Card>
  );
}
