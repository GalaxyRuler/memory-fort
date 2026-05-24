import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type SearchScope, useSearch } from "../hooks/useSearch.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { Input } from "./Input.js";
import { SearchFilters } from "./SearchFilters.js";
import { SearchResultCard } from "./SearchResultCard.js";

interface SearchPageSearch {
  q?: string;
  scope?: SearchScope;
  k?: number;
  noRerank?: boolean;
}

export function SearchPage() {
  const params = useRouterSearch({ from: "/search" }) as SearchPageSearch;
  const navigate = useNavigate({ from: "/search" });
  const [inputValue, setInputValue] = useState(params.q ?? "");
  const debouncedQuery = useDebouncedValue(inputValue, 200);
  const scope = params.scope ?? "wiki";
  const k = params.k ?? 20;
  const noRerank = params.noRerank ?? false;
  const search = useSearch({
    query: debouncedQuery,
    scope,
    k,
    noRerank,
    enabled: debouncedQuery.trim().length > 0,
  });

  useEffect(() => {
    setInputValue(params.q ?? "");
  }, [params.q]);

  useEffect(() => {
    if (debouncedQuery !== (params.q ?? "")) {
      navigate({
        search: (previous: SearchPageSearch) => ({
          ...previous,
          q: debouncedQuery || undefined,
        }),
        replace: true,
      });
    }
  }, [debouncedQuery, navigate, params.q]);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <header className="mb-6">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Search</h1>
        <Input
          autoFocus
          className="w-full font-mono"
          onChange={(event) => setInputValue(event.currentTarget.value)}
          placeholder="Search memory..."
          value={inputValue}
        />
        {search.data ? (
          <p className="mt-2 font-mono text-xs text-text-muted">
            {search.data.results.length} results in {search.data.timings.totalMs}ms
            {search.data.degraded ? " - degraded" : ""}
            {search.data.warnings.length > 0
              ? ` - ${search.data.warnings.length} warning${search.data.warnings.length === 1 ? "" : "s"}`
              : ""}
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[256px_1fr]">
        <SearchFilters
          k={k}
          noRerank={noRerank}
          onChange={(next) =>
            navigate({
              search: (previous: SearchPageSearch) => ({ ...previous, ...next }),
              replace: true,
            })
          }
          scope={scope}
        />
        <div className="space-y-3">
          {!debouncedQuery ? (
            <p className="px-2 text-sm text-text-muted">Type a query to begin searching memory.</p>
          ) : null}
          {debouncedQuery && search.isLoading ? (
            <p className="px-2 text-sm text-text-muted">Searching...</p>
          ) : null}
          {debouncedQuery && search.data && search.data.results.length === 0 && !search.isLoading ? (
            <p className="px-2 text-sm text-text-muted">No results for &quot;{debouncedQuery}&quot;.</p>
          ) : null}
          {search.data?.results.map((result) => (
            <SearchResultCard key={result.path} result={result} />
          ))}
        </div>
      </div>
    </div>
  );
}
