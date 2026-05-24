import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRawIndex } from "../hooks/useRawIndex.js";
import { parseSourceFromFilename, type RawSource } from "../lib/raw-helpers.js";
import { RawFilters } from "./RawFilters.js";
import { SessionRow } from "./SessionRow.js";

export function RawBrowsePage() {
  const raw = useRawIndex();
  const params = useSearch({ from: "/raw" }) as { source?: RawSource | "all" };
  const navigate = useNavigate({ from: "/raw" });
  const sourceFilter = params.source ?? "all";

  const filteredEntries = (raw.data ?? [])
    .map((entry) => ({
      ...entry,
      files: sourceFilter === "all"
        ? entry.files
        : entry.files.filter((file) => parseSourceFromFilename(file.filename) === sourceFilter),
    }))
    .filter((entry) => entry.files.length > 0);

  const totalCount = filteredEntries.reduce((sum, entry) => sum + entry.files.length, 0);

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
          onChange={(source) => navigate({ search: { source: source === "all" ? undefined : source }, replace: true })}
        />
        <div>
          {raw.isLoading && <p className="text-sm text-text-muted px-2">Loading raws...</p>}
          {filteredEntries.length === 0 && !raw.isLoading && (
            <p className="text-sm text-text-muted px-2">No sessions match this filter.</p>
          )}
          {filteredEntries.map((entry) => (
            <section key={entry.date} className="mb-6">
              <h2 className="mb-2 break-words font-mono text-xs uppercase tracking-wider text-text-muted">
                {entry.date} - {entry.files.length} session{entry.files.length === 1 ? "" : "s"}
              </h2>
              {entry.files.map((file) => (
                <SessionRow key={file.filename} file={file} date={entry.date} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
