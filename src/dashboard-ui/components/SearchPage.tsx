import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { type SearchScope, useSearch } from "../hooks/useSearch.js";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { EmptyState } from "./EmptyState.js";
import { Input } from "./Input.js";
import { SearchFilters } from "./SearchFilters.js";
import { resultLinkProps, SearchResultCard } from "./SearchResultCard.js";
import { Skeleton } from "./Skeleton.js";

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
  const results = search.data?.results ?? [];
  const listNav = useListKeyNav({
    items: results,
    getKey: (result) => result.path,
    onActivate: (result) => {
      const linkProps = resultLinkProps(result);
      if (!linkProps) return;
      navigate(linkProps);
    },
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
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="mb-2 break-words text-2xl font-semibold tracking-tight">Search</h1>
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
            <EmptyState
              icon={Search}
              title="Type a query to begin"
              description="Type a query to begin searching memory."
            />
          ) : null}
          {debouncedQuery && search.isLoading ? (
            <div className="space-y-3" aria-label="Searching memory">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} variant="card" />
              ))}
            </div>
          ) : null}
          {debouncedQuery && search.data && search.data.results.length === 0 && !search.isLoading ? (
            <EmptyState
              icon={Search}
              title={`No results for "${debouncedQuery}".`}
              description="Try a different query or broaden the scope filter."
            />
          ) : null}
          {results.length > 0 ? (
            <div aria-label="Search results" className="space-y-3" role="list" {...listNav.listProps}>
              {results.map((result, index) => (
                <SearchResultCard
                  key={result.path}
                  result={result}
                  keyboardProps={{ role: "listitem", ...listNav.getItemProps(index) }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
