import type { GraphScope } from "../../hooks/useGraph.js";

const SCOPES: Array<{ scope: GraphScope; label: string }> = [
  { scope: "all", label: "ALL" },
  { scope: "wiki", label: "WIKI" },
  { scope: "raw", label: "RAW" },
  { scope: "crystals", label: "CRYSTALS" },
];

export function ScopeToggle({
  scope,
  onChange,
}: {
  scope: GraphScope;
  onChange: (scope: GraphScope) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border-subtle bg-surface/80 p-1 font-mono text-[10px] shadow-lg backdrop-blur">
      {SCOPES.map((item) => (
        <button
          key={item.scope}
          type="button"
          className={
            item.scope === scope
              ? "rounded bg-primary px-2 py-1 text-background"
              : "rounded px-2 py-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
          }
          onClick={() => onChange(item.scope)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
