import { CircleDot as Orbit, Clock, Crosshair, Layers, Search, Sparkles, Wind, X } from "lucide-react";
import { cn } from "../lib/cn.js";
import { type GraphMode } from "../lib/graph-layouts.js";

const MODES: Array<{ value: GraphMode; label: string; icon: typeof Wind }> = [
  { value: "force", label: "Force", icon: Wind },
  { value: "clustered", label: "Clustered", icon: Layers },
  { value: "constellation", label: "Star", icon: Sparkles },
  { value: "orbital", label: "Orbital", icon: Orbit },
  { value: "timeline-flow", label: "Time", icon: Clock },
];

const ENTITY_TYPES = ["projects", "decisions", "lessons", "references", "tools", "crystal"];

export interface GraphHUDProps {
  mode: GraphMode;
  enabledTypes: Set<string>;
  searchQuery: string;
  searchMatchCount: number;
  focusModeLabel?: string | null;
  onModeChange: (mode: GraphMode) => void;
  onSearchChange: (query: string) => void;
  onToggleType: (type: string) => void;
  onClearFocusMode?: () => void;
}

export function GraphHUD({
  mode,
  enabledTypes,
  searchQuery,
  searchMatchCount,
  focusModeLabel,
  onModeChange,
  onSearchChange,
  onToggleType,
  onClearFocusMode,
}: GraphHUDProps) {
  const hasSearch = searchQuery.trim().length > 0;

  return (
    <div className="glass-blur absolute left-4 top-4 z-10 w-56 space-y-3 rounded-lg p-3">
      <div>
        <label htmlFor="graph-search" className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Search
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" size={13} strokeWidth={1.5} />
          <input
            id="graph-search"
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Find node"
            className="w-full rounded-md border border-border-subtle bg-surface/70 py-1.5 pl-7 pr-2 font-mono text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-primary/60"
          />
        </div>
        {hasSearch && (
          <div className="mt-1.5 inline-flex rounded-full border border-border-subtle bg-surface/70 px-2 py-0.5 font-mono text-[10px] text-text-secondary">
            {searchMatchCount} {searchMatchCount === 1 ? "match" : "matches"}
          </div>
        )}
        {focusModeLabel && onClearFocusMode && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border-subtle bg-surface/70 px-2 py-1.5 text-[11px] text-text-secondary">
            <Crosshair size={13} strokeWidth={1.5} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">Focus: {focusModeLabel}</span>
            <button
              type="button"
              aria-label="Clear focus mode"
              onClick={onClearFocusMode}
              className="rounded text-text-muted transition-colors hover:text-text-primary"
            >
              <X size={13} strokeWidth={1.5} />
            </button>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">Mode</h3>
        <div className="grid grid-cols-5 gap-1">
          {MODES.map((modeOption) => {
            const Icon = modeOption.icon;
            const isActive = mode === modeOption.value;
            return (
              <button
                key={modeOption.value}
                type="button"
                aria-label={`Switch graph mode to ${modeOption.label}`}
                onClick={() => onModeChange(modeOption.value)}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md px-1 py-1.5 text-[10px] transition-colors",
                  isActive ? "bg-surface-2 text-text-primary" : "text-text-secondary hover:text-text-primary",
                )}
              >
                <Icon size={14} strokeWidth={1.5} />
                <span>{modeOption.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">Entity filter</h3>
        <div className="space-y-1">
          {ENTITY_TYPES.map((type) => (
            <label key={type} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={enabledTypes.has(type)}
                onChange={() => onToggleType(type)}
                className="rounded border-border-emphasis bg-surface"
              />
              <span className="capitalize text-text-secondary">{type}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
