import { useNavigate } from "@tanstack/react-router";
import { DialogDescription, DialogTitle } from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useCommandPaletteContext } from "../hooks/useCommandPalette.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { useSearch, type SearchResult, type SearchScope } from "../hooks/useSearch.js";
import { cn } from "../lib/cn.js";
import { formatSearchSourceLabel, KNOWN_SEARCH_SOURCES } from "../lib/search-sources.js";

const SCOPES: { value: SearchScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "wiki", label: "Wiki" },
  { value: "raw", label: "Raw" },
  { value: "crystals", label: "Crystals" },
];

export function CommandPalette() {
  const { open, setOpen, close } = useCommandPaletteContext();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const debouncedQuery = useDebouncedValue(query, 150);
  const search = useSearch({ query: debouncedQuery, scope, k: 12, noRerank: true });
  const navigate = useNavigate();
  const results = search.data?.results ?? [];
  const resultSourceSummary = search.data ? sourceSummary(results) : "";

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Search memory"
      shouldFilter={false}
      loop
      overlayClassName="fixed inset-0 z-50 bg-background/60 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[10vh] z-50 w-[calc(100vw-2rem)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl glass-blur shadow-2xl"
    >
      <DialogTitle className="sr-only">Search memory</DialogTitle>
      <DialogDescription className="sr-only">
        Search memory results and navigate to matching pages.
      </DialogDescription>
      <Command.Input
        aria-label="Search memory"
        autoFocus
        placeholder="Search memory..."
        value={query}
        onValueChange={setQuery}
        className="w-full border-b border-border-subtle bg-transparent px-4 py-3 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-3 py-2 text-xs">
        <span className="mr-1 text-text-muted">Scope:</span>
        {SCOPES.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setScope(item.value)}
            className={cn(
              "rounded-md px-2 py-0.5 transition-colors",
              scope === item.value
                ? "bg-surface-2 text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <Command.List className="max-h-[50vh] overflow-y-auto p-1">
        {search.isLoading && debouncedQuery && (
          <Command.Loading>
            <p className="px-4 py-3 text-sm text-text-muted">Searching...</p>
          </Command.Loading>
        )}
        {!debouncedQuery && (
          <Command.Empty>
            <p className="px-4 py-3 text-sm text-text-muted">Type to search memory.</p>
          </Command.Empty>
        )}
        {debouncedQuery && search.data && results.length === 0 && !search.isLoading && (
          <Command.Empty>
            <p className="px-4 py-3 text-sm text-text-muted">No results.</p>
          </Command.Empty>
        )}
        {results.map((result) => (
          <Command.Item
            key={result.path}
            value={result.path}
            onSelect={() => {
              close();
              navigateToResult(result, navigate);
            }}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm aria-selected:bg-surface-2"
          >
            <span
              className={cn("mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full", kindToColor(result.kind))}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-text-primary">{result.title}</p>
              <p className="truncate font-mono text-xs text-text-muted">{result.path}</p>
            </div>
            <span className="ml-2 flex-shrink-0 font-mono text-xs text-text-muted">
              {result.score.toFixed(2)}
            </span>
          </Command.Item>
        ))}
      </Command.List>
      {search.data && (
        <div className="flex items-center justify-between border-t border-border-subtle px-3 py-2 font-mono text-[10px] text-text-muted">
          <span>
            {results.length} results
            {resultSourceSummary ? ` · ${resultSourceSummary}` : ""}
          </span>
          <span>
            {search.data.timings.totalMs}ms{search.data.degraded ? " · degraded" : ""} · fast
          </span>
        </div>
      )}
    </Command.Dialog>
  );
}

function sourceSummary(results: SearchResult[]): string {
  return KNOWN_SEARCH_SOURCES
    .filter((source) =>
      results.some((result) => result.sources.some((item) => item.source === source)),
    )
    .map((source) => formatSearchSourceLabel(source))
    .join(" · ");
}

function kindToColor(kind: SearchResult["kind"]): string {
  switch (kind) {
    case "wiki":
      return "bg-entity-projects";
    case "raw":
      return "bg-entity-raw-session";
    case "crystal":
      return "bg-entity-crystals";
  }
}

function navigateToResult(result: SearchResult, navigate: ReturnType<typeof useNavigate>) {
  if (result.kind === "wiki" && result.path.startsWith("wiki/")) {
    const parts = result.path.replace(/^wiki\//, "").replace(/\.md$/, "").split("/");
    if (parts.length >= 2) {
      void navigate({
        to: "/wiki/$category/$slug",
        params: { category: parts[0], slug: parts.slice(1).join("/") },
      });
      return;
    }
  }

  if (result.kind === "raw" && result.path.startsWith("raw/")) {
    const parts = result.path.replace(/^raw\//, "").replace(/\.md$/, "").split("/");
    if (parts.length >= 2) {
      void navigate({
        to: "/raw/$date/$filename",
        params: { date: parts[0], filename: parts.slice(1).join("/") },
      });
    }
  }

  if (result.kind === "crystal") {
    void navigate({ to: "/crystals" });
  }
}
