import { useNavigate, useSearch } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { useEffect, useState } from "react";
import { useListKeyNav } from "../hooks/useListKeyNav.js";
import { useActivity, type ActivityEvent } from "../hooks/useActivity.js";
import { readPageSize } from "../lib/pagination.js";
import { ActivityEventRow } from "./ActivityEventRow.js";
import { ActivityFilters } from "./ActivityFilters.js";
import { EmptyState } from "./EmptyState.js";

const SOURCES = new Set<ActivityEvent["source"]>(["git", "compile", "sync", "lint", "errors"]);
const LEVELS = new Set<ActivityEvent["level"]>(["info", "warn", "error"]);

function readSource(value: string | undefined): ActivityEvent["source"] | "all" {
  return value && SOURCES.has(value as ActivityEvent["source"]) ? (value as ActivityEvent["source"]) : "all";
}

function readLevel(value: string | undefined): ActivityEvent["level"] | "all" {
  return value && LEVELS.has(value as ActivityEvent["level"]) ? (value as ActivityEvent["level"]) : "all";
}

export function ActivityFeedPage() {
  const params = useSearch({ from: "/activity" }) as { source?: string; level?: string; per?: string };
  const navigate = useNavigate({ from: "/activity" });
  const sourceFilter = readSource(params.source);
  const levelFilter = readLevel(params.level);
  const pageSize = readPageSize(params.per);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const activity = useActivity(100);

  const filtered = (activity.data?.events ?? []).filter((event) => {
    if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
    if (levelFilter !== "all" && event.level !== levelFilter) return false;
    return true;
  });
  const visibleEvents = filtered.slice(0, visibleCount);
  const listNav = useListKeyNav({
    items: visibleEvents,
    getKey: (event, index) => `${event.timestamp}-${index}`,
    onActivate: () => undefined,
  });

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [pageSize, sourceFilter, levelFilter]);

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-text-secondary">
          {filtered.length} event{filtered.length === 1 ? "" : "s"} shown
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
        <ActivityFilters
          source={sourceFilter}
          level={levelFilter}
          onChange={(next) =>
            navigate({
              search: (prev: { source?: string; level?: string }) => ({
                ...prev,
                source: next.source === "all" ? undefined : next.source ?? prev.source,
                level: next.level === "all" ? undefined : next.level ?? prev.level,
              }),
              replace: true,
            })
          }
        />
        <div>
          {activity.isLoading && <p className="text-sm text-text-muted px-2">Loading activity...</p>}
          {!activity.isLoading && filtered.length === 0 && (
            <EmptyState
              icon={Activity}
              title="No events match these filters"
              description="Adjust the source or level filter to inspect the activity stream."
            />
          )}
          <ul {...listNav.listProps}>
            {visibleEvents.map((event, index) => (
              <ActivityEventRow
                key={`${event.timestamp}-${index}`}
                event={event}
                keyboardProps={listNav.getItemProps(index)}
              />
            ))}
          </ul>
          {filtered.length > visibleEvents.length ? (
            <div className="mt-4 text-center">
              <p className="mb-2 text-xs text-text-muted">Showing {visibleEvents.length} of {filtered.length}</p>
              <button
                type="button"
                onClick={() => setVisibleCount((current) => Math.min(filtered.length, current + pageSize))}
                className="min-h-11 rounded-md border border-border-subtle px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary md:min-h-8"
              >
                Load more activity
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
