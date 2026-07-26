import { useNavigate, useSearch as useRouterSearch } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { type SearchIndexStatus, type SearchScope, useSearch, useSearchCapabilities } from "../hooks/useSearch.js";
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
  includeArchived?: "1";
}

export function SearchPage() {
  const params = useRouterSearch({ from: "/search" }) as SearchPageSearch;
  const navigate = useNavigate({ from: "/search" });
  const [inputValue, setInputValue] = useState(params.q ?? "");
  const debouncedQuery = useDebouncedValue(inputValue, 200);
  const scope = params.scope ?? "wiki";
  const k = params.k ?? 20;
  const noRerank = params.noRerank ?? false;
  const includeArchived = params.includeArchived === "1";
  const capabilities = useSearchCapabilities();
  const supportedParams = capabilities.data?.supportedParams ?? [];
  const scopes = capabilities.data?.scopes ?? [];
  const effectiveNoRerank = supportedParams.includes("noRerank") && noRerank;
  const search = useSearch({
    query: debouncedQuery,
    scope,
    k,
    ...(supportedParams.includes("noRerank") ? { noRerank: effectiveNoRerank } : {}),
    ...(supportedParams.includes("includeArchived") ? { includeArchived } : {}),
    enabled: debouncedQuery.trim().length > 0,
  });
  const results = search.data?.results ?? [];
  const indexStatus = search.data?.index;
  const indexIsHealthy = isPositiveIndexHealth(indexStatus);
  const searchHasHealthWarning = Boolean(search.data && (search.data.degraded || search.data.warnings.length > 0));
  const showIndexNotice = Boolean(
    search.data && (searchHasHealthWarning || (indexStatus && !indexIsHealthy)),
  );
  const showNoResults = Boolean(
    debouncedQuery &&
    search.data &&
    search.data.results.length === 0 &&
    !search.isLoading &&
    !searchHasHealthWarning &&
    (!indexStatus || indexIsHealthy),
  );
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
          aria-label="Search memory"
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
          includeArchived={includeArchived}
          supportedParams={supportedParams}
          scopes={scopes}
          onChange={({ includeArchived: nextIncludeArchived, ...next }) =>
            navigate({
              search: (previous: SearchPageSearch) => ({
                ...previous,
                ...next,
                ...(nextIncludeArchived === undefined
                  ? {}
                  : { includeArchived: nextIncludeArchived ? "1" : undefined }),
              }),
              replace: true,
            })
          }
          scope={scope}
        />
        <div className="space-y-3">
          {search.data?.ignoredParams && search.data.ignoredParams.length > 0 ? (
            <div
              className="rounded-md border border-warning/40 bg-surface px-4 py-3 text-sm text-text-secondary"
              role="status"
            >
              Backend ignored: {search.data.ignoredParams.join(", ")}
            </div>
          ) : null}
          {search.data && showIndexNotice ? (
            <SearchIndexNotice
              degraded={search.data.degraded}
              index={indexStatus}
              warnings={search.data.warnings}
            />
          ) : null}
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
          {showNoResults ? (
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

function SearchIndexNotice({
  degraded,
  index,
  warnings,
}: {
  degraded: boolean;
  index: SearchIndexStatus | undefined;
  warnings: readonly string[];
}) {
  const state = index?.currentState.toLowerCase() ?? "";
  const indexing = Boolean(
    index && (INDEXING_INDEX_STATES.has(state) || (!index.ready && warnings.includes("indexing"))),
  );
  const title = indexing ? "Indexing in progress" : "Search index degraded";
  const skippedText = `${index?.filesSkipped ?? 0} skipped`;
  return (
    <section
      aria-label="Search index status"
      className="rounded-md border border-border-subtle bg-surface px-4 py-3"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {indexing ? "Indexed results may be incomplete while the vault is being indexed." : "Results may be incomplete."}
          </p>
        </div>
        {degraded ? (
          <span className="font-mono text-xs text-text-muted">degraded</span>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-text-muted">Index path</dt>
          <dd className="break-all font-mono text-text-primary">{index?.dbPath ?? "not available"}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Size</dt>
          <dd className="font-mono text-text-primary">{formatBytes(index?.sizeBytes ?? 0)}</dd>
        </div>
        <div>
          <dt className="text-text-muted">State</dt>
          <dd className="font-mono text-text-primary">{index?.currentState ?? "unknown"}</dd>
        </div>
        <div>
          <dt className="text-text-muted">Skipped</dt>
          <dd className="font-mono text-text-primary">{skippedText}</dd>
        </div>
      </dl>
      {index?.lastError ? (
        <p className="mt-3 break-words font-mono text-xs text-danger">{index.lastError}</p>
      ) : null}
      <p className="mt-3 font-mono text-xs text-text-muted">
        Legacy rollback: MEMORY_INDEX_SEARCH=0
      </p>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${Math.round(value)} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

const HEALTHY_INDEX_STATES = new Set(["idle", "ok", "ready"]);
const INDEXING_INDEX_STATES = new Set(["backfilling", "building", "tombstoning", "walking"]);

function isPositiveIndexHealth(index: SearchIndexStatus | undefined): boolean {
  return Boolean(
    index &&
    index.ready &&
    !index.lastError &&
    HEALTHY_INDEX_STATES.has(index.currentState.toLowerCase()),
  );
}
