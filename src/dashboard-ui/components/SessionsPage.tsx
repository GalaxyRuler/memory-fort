import { useNavigate, useSearch } from "@tanstack/react-router";
import { type RawIndexFile, useRawIndex } from "../hooks/useRawIndex.js";
import { parseSourceFromFilename, type RawSource } from "../lib/raw-helpers.js";
import { RawFilters } from "./RawFilters.js";
import { SessionTile } from "./SessionTile.js";

const VALID_SOURCES = new Set<RawSource>(["claude-code", "codex", "antigravity", "manual", "unknown"]);

interface SessionTileEntry {
  date: string;
  file: RawIndexFile;
}

function readSourceFilter(value: unknown): RawSource | "all" {
  return typeof value === "string" && VALID_SOURCES.has(value as RawSource) ? (value as RawSource) : "all";
}

export function SessionsPage() {
  const raw = useRawIndex();
  const params = useSearch({ from: "/sessions" }) as { source?: string };
  const navigate = useNavigate({ from: "/sessions" });
  const sourceFilter = readSourceFilter(params.source);

  const tiles: SessionTileEntry[] = [];
  for (const entry of raw.data ?? []) {
    for (const file of entry.files) {
      if (sourceFilter === "all" || parseSourceFromFilename(file.filename) === sourceFilter) {
        tiles.push({ date: entry.date, file });
      }
    }
  }

  tiles.sort((a, b) => new Date(b.file.mtime).getTime() - new Date(a.file.mtime).getTime());
  const visibleTiles = tiles.slice(0, 60);

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
          onChange={(source) => navigate({ search: { source: source === "all" ? undefined : source }, replace: true })}
        />
        <div>
          {raw.isLoading && <p className="px-2 text-sm text-text-muted">Loading sessions...</p>}
          {tiles.length === 0 && !raw.isLoading && <p className="px-2 text-sm text-text-muted">No sessions match this filter.</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleTiles.map((tile) => (
              <SessionTile key={`${tile.date}/${tile.file.filename}`} file={tile.file} date={tile.date} />
            ))}
          </div>
          {tiles.length > 60 && (
            <p className="mt-4 text-center text-xs text-text-muted">
              Showing 60 of {tiles.length}. Refine filter to see more.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
