import { useNavigate, useSearch } from "@tanstack/react-router";
import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { type RawIndexFile, useRawIndex } from "../hooks/useRawIndex.js";
import { readPageSize } from "../lib/pagination.js";
import { parseSourceFromFilename, RAW_SOURCES, type RawSource } from "../lib/raw-helpers.js";
import { EmptyState } from "./EmptyState.js";
import { RawFilters } from "./RawFilters.js";
import { SessionTile } from "./SessionTile.js";

const VALID_SOURCES = new Set<RawSource>(RAW_SOURCES);

interface SessionTileEntry {
  date: string;
  file: RawIndexFile;
}

function readSourceFilter(value: unknown): RawSource | "all" {
  return typeof value === "string" && VALID_SOURCES.has(value as RawSource) ? (value as RawSource) : "all";
}

export function SessionsPage() {
  const raw = useRawIndex();
  const params = useSearch({ from: "/sessions" }) as { source?: string; per?: string };
  const navigate = useNavigate({ from: "/sessions" });
  const sourceFilter = readSourceFilter(params.source);
  const pageSize = readPageSize(params.per);
  const [visibleCount, setVisibleCount] = useState(pageSize);

  const tiles: SessionTileEntry[] = [];
  for (const entry of raw.data ?? []) {
    for (const file of entry.files) {
      if (sourceFilter === "all" || parseSourceFromFilename(file.filename) === sourceFilter) {
        tiles.push({ date: entry.date, file });
      }
    }
  }

  tiles.sort((a, b) => new Date(b.file.mtime).getTime() - new Date(a.file.mtime).getTime());
  const visibleTiles = tiles.slice(0, visibleCount);
  const listNav = useListKeyNav({
    items: visibleTiles,
    getKey: (tile) => `${tile.date}/${tile.file.filename}`,
    onActivate: (tile) =>
      navigate({
        to: "/raw/$date/$filename",
        params: { date: tile.date, filename: tile.file.filename },
      }),
  });

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [pageSize, sourceFilter]);

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="text-sm text-text-secondary">
          {tiles.length} captured session{tiles.length === 1 ? "" : "s"}
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
        <div>
          {raw.isLoading && <p className="px-2 text-sm text-text-muted">Loading sessions...</p>}
          {tiles.length === 0 && !raw.isLoading && (
            <EmptyState
              icon={Terminal}
              title="No sessions match this filter"
              description="Choose another tool filter to review captured sessions."
            />
          )}
          <ul
            aria-label="Sessions"
            className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3"
            {...listNav.listProps}
          >
            {visibleTiles.map((tile, index) => (
              <SessionTile
                key={`${tile.date}/${tile.file.filename}`}
                file={tile.file}
                date={tile.date}
                keyboardProps={listNav.getItemProps(index)}
              />
            ))}
          </ul>
          {tiles.length > visibleTiles.length ? (
            <div className="mt-4 text-center">
              <p className="mb-2 text-xs text-text-muted">Showing {visibleTiles.length} of {tiles.length}</p>
              <button
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(tiles.length, current + pageSize))}
                className="min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:min-h-8"
              >
                Load more sessions
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
