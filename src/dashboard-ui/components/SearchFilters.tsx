import { type SearchScope } from "../hooks/useSearch.js";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";

export interface SearchFiltersProps {
  scope: SearchScope;
  k: number;
  noRerank: boolean;
  onChange: (next: { scope?: SearchScope; k?: number; noRerank?: boolean }) => void;
}

const SCOPE_OPTIONS: Array<{ value: SearchScope; label: string; hint?: string }> = [
  { value: "wiki", label: "Wiki", hint: "fast" },
  { value: "all", label: "All", hint: "slower; includes raws + crystals" },
  { value: "raw", label: "Raw" },
  { value: "crystals", label: "Crystals" },
];

const K_OPTIONS = [10, 20, 50] as const;

export function SearchFilters({ scope, k, noRerank, onChange }: SearchFiltersProps) {
  return (
    <Card className="sticky top-4 space-y-4">
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wider text-text-muted">Scope</h3>
        <div className="space-y-1">
          {SCOPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                scope === option.value
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
              )}
              onClick={() => onChange({ scope: option.value })}
              type="button"
            >
              <span>{option.label}</span>
              {option.hint ? <span className="text-[10px] text-text-muted">{option.hint}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wider text-text-muted">Results per page</h3>
        <div className="flex gap-1">
          {K_OPTIONS.map((option) => (
            <button
              key={option}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-sm transition-colors",
                k === option
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:bg-surface-2/50 hover:text-text-primary",
              )}
              onClick={() => onChange({ k: option })}
              type="button"
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wider text-text-muted">Options</h3>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            checked={noRerank}
            className="rounded border-border-emphasis bg-surface"
            onChange={(event) => onChange({ noRerank: event.target.checked })}
            type="checkbox"
          />
          <span>Skip Voyage rerank</span>
          <span className="ml-1 text-[10px] text-text-muted">faster, less accurate</span>
        </label>
      </div>
    </Card>
  );
}
