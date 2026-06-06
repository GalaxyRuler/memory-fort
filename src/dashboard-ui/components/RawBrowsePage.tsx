import { useNavigate, useSearch } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { useRawIndex } from "../hooks/useRawIndex.js";
import { readPageSize } from "../lib/pagination.js";
import { parseSourceFromFilename, type RawSource } from "../lib/raw-helpers.js";
import { EmptyState } from "./EmptyState.js";
import { RawFilters } from "./RawFilters.js";
import { SessionRow } from "./SessionRow.js";
import { Skeleton } from "./Skeleton.js";

export function RawBrowsePage() {
  const raw = useRawIndex();
  const params = useSearch({ from: "/raw/" }) as { source?: RawSource | "all"; per?: string };
  const navigate = useNavigate({ from: "/raw/" });
  const sourceFilter = params.source ?? "all";
  const pageSize = readPageSize(params.per);
  const [visibleCount, setVisibleCount] = useState(pageSize);

  const filteredEntries = (raw.data ?? [])
    .map((entry) => ({
      ...entry,
      files: sourceFilter === "all"
        ? entry.files
        : entry.files.filter((file) => parseSourceFromFilename(file.filename) === sourceFilter),
    }))
    .filter((entry) => entry.files.length > 0);

  const totalCount = filteredEntries.reduce((sum, entry) => sum + entry.files.length, 0);
  const rows = filteredEntries.flatMap((entry) => entry.files.map((file) => ({ date: entry.date, file })));
  const visibleRows = rows.slice(0, visibleCount);
  const visibleEntries = filteredEntries
    .map((entry) => ({
      ...entry,
      files: visibleRows.filter((row) => row.date === entry.date).map((row) => row.file),
    }))
    .filter((entry) => entry.files.length > 0);
  const rowIndexByKey = new Map(rows.map((row, index) => [`${row.date}/${row.file.filename}`, index]));
  const listNav = useListKeyNav({
    items: visibleRows,
    getKey: (row) => `${row.date}/${row.file.filename}`,
    onActivate: (row) =>
      navigate({
        to: "/raw/$date/$filename",
        params: { date: row.date, filename: row.file.filename },
      }),
  });

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [pageSize, sourceFilter]);

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Raw observations</h1>
        <p className="text-sm text-text-secondary">
          {totalCount} session{totalCount === 1 ? "" : "s"} captured
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
        <RawFilters
          source={sourceFilter}
          onChange={(source) => navigate({
            search: { per: params.per, source: source === "all" ? undefined : source },
            replace: true,
          })}
        />
        <div aria-label="Raw sessions" role="list" {...listNav.listProps}>
          {raw.isLoading && (
            <div className="space-y-3" aria-label="Loading raw observations">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-16" variant="block" />
              ))}
            </div>
          )}
          {filteredEntries.length === 0 && !raw.isLoading && (
            <EmptyState
              icon={Terminal}
              title="No sessions match this filter"
              description="Choose another tool filter to inspect captured raw observations."
            />
          )}
          {visibleEntries.map((entry) => (
            <section key={entry.date} className="mb-6" role="listitem">
              <h2 className="mb-2 break-words font-mono text-xs uppercase tracking-wider text-text-muted">
                {entry.date} - {entry.files.length} session{entry.files.length === 1 ? "" : "s"}
              </h2>
              <ul aria-label={`Raw sessions on ${entry.date}`} className="m-0 list-none p-0">
                {entry.files.map((file) => (
                  <SessionRow
                    key={file.filename}
                    file={file}
                    date={entry.date}
                    keyboardProps={listNav.getItemProps(rowIndexByKey.get(`${entry.date}/${file.filename}`) ?? 0)}
                  />
                ))}
              </ul>
            </section>
          ))}
          {rows.length > visibleRows.length ? (
            <div className="mt-4 text-center">
              <p className="mb-2 text-xs text-text-muted">Showing {visibleRows.length} of {rows.length}</p>
              <button
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(rows.length, current + pageSize))}
                className="min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:min-h-8"
              >
                Load more raw sessions
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
