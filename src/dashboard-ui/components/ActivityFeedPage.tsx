import { useNavigate, useSearch } from "@tanstack/react-router";
import { useActivity, type ActivityEvent } from "../hooks/useActivity.js";
import { ActivityEventRow } from "./ActivityEventRow.js";
import { ActivityFilters } from "./ActivityFilters.js";

const SOURCES = new Set<ActivityEvent["source"]>(["git", "compile", "sync", "lint", "errors"]);
const LEVELS = new Set<ActivityEvent["level"]>(["info", "warn", "error"]);

function readSource(value: string | undefined): ActivityEvent["source"] | "all" {
  return value && SOURCES.has(value as ActivityEvent["source"]) ? (value as ActivityEvent["source"]) : "all";
}

function readLevel(value: string | undefined): ActivityEvent["level"] | "all" {
  return value && LEVELS.has(value as ActivityEvent["level"]) ? (value as ActivityEvent["level"]) : "all";
}

export function ActivityFeedPage() {
  const params = useSearch({ from: "/activity" }) as { source?: string; level?: string };
  const navigate = useNavigate({ from: "/activity" });
  const sourceFilter = readSource(params.source);
  const levelFilter = readLevel(params.level);
  const activity = useActivity(100);

  const filtered = (activity.data?.events ?? []).filter((event) => {
    if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
    if (levelFilter !== "all" && event.level !== levelFilter) return false;
    return true;
  });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-text-secondary">
          {filtered.length} event{filtered.length === 1 ? "" : "s"} shown
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4">
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
            <p className="text-sm text-text-muted px-2">No events match these filters.</p>
          )}
          <ul>
            {filtered.map((event, index) => (
              <ActivityEventRow key={`${event.timestamp}-${index}`} event={event} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
