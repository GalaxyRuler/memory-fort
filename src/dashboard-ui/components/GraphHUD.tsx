import { Layers, Sparkles, Wind } from "lucide-react";
import { cn } from "../lib/cn.js";
import { type GraphMode } from "../lib/graph-layouts.js";

const MODES: Array<{ value: GraphMode; label: string; icon: typeof Wind }> = [
  { value: "force", label: "Force", icon: Wind },
  { value: "clustered", label: "Clustered", icon: Layers },
  { value: "constellation", label: "Constellation", icon: Sparkles },
];

const ENTITY_TYPES = ["projects", "decisions", "lessons", "references", "tools", "crystal"];

export interface GraphHUDProps {
  mode: GraphMode;
  enabledTypes: Set<string>;
  onModeChange: (mode: GraphMode) => void;
  onToggleType: (type: string) => void;
}

export function GraphHUD({ mode, enabledTypes, onModeChange, onToggleType }: GraphHUDProps) {
  return (
    <div className="glass-blur absolute left-4 top-4 z-10 w-56 space-y-3 rounded-lg p-3">
      <div>
        <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-text-muted">Mode</h3>
        <div className="grid grid-cols-3 gap-1">
          {MODES.map((modeOption) => {
            const Icon = modeOption.icon;
            const isActive = mode === modeOption.value;
            return (
              <button
                key={modeOption.value}
                type="button"
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
