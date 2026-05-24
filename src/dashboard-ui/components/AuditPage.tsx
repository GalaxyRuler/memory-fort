import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { type ActivityEvent, useActivity } from "../hooks/useActivity.js";
import { cn } from "../lib/cn.js";
import { AuditRow } from "./AuditRow.js";
import { Card } from "./Card.js";
import { Input } from "./Input.js";

const LEVELS: Array<{ value: ActivityEvent["level"] | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

const SOURCES: Array<{ value: ActivityEvent["source"] | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "git", label: "Git" },
  { value: "compile", label: "Compile" },
  { value: "sync", label: "Sync" },
  { value: "lint", label: "Lint" },
  { value: "errors", label: "Errors" },
];

const VALID_LEVELS = new Set<ActivityEvent["level"]>(["info", "warn", "error"]);
const VALID_SOURCES = new Set<ActivityEvent["source"]>(["git", "compile", "sync", "lint", "errors"]);

function readLevel(value: unknown): ActivityEvent["level"] | "all" {
  return typeof value === "string" && VALID_LEVELS.has(value as ActivityEvent["level"])
    ? (value as ActivityEvent["level"])
    : "all";
}

function readSource(value: unknown): ActivityEvent["source"] | "all" {
  return typeof value === "string" && VALID_SOURCES.has(value as ActivityEvent["source"])
    ? (value as ActivityEvent["source"])
    : "all";
}

export function AuditPage() {
  const params = useSearch({ from: "/audit" }) as { source?: string; level?: string };
  const navigate = useNavigate({ from: "/audit" });
  const sourceFilter = readSource(params.source);
  const levelFilter = readLevel(params.level);
  const [search, setSearch] = useState("");

  const activity = useActivity(200);

  const events = (activity.data?.events ?? []).filter((event) => {
    if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
    if (levelFilter !== "all" && event.level !== levelFilter) return false;
    if (search && !event.summary.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-4">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-sm text-text-secondary">
          Unified stream: git, sync, compile, lint, errors. {events.length} entries shown.
        </p>
      </header>

      <Card className="mb-3 space-y-2">
        <Input
          placeholder="Search audit log..."
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          className="font-mono"
        />
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="self-center text-text-muted">Level:</span>
          {LEVELS.map((level) => (
            <button
              key={level.value}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev: { source?: string; level?: string }) => ({
                    ...prev,
                    level: level.value === "all" ? undefined : level.value,
                  }),
                  replace: true,
                })
              }
              className={cn(
                "min-h-11 rounded-md px-3 py-1 transition-colors md:min-h-8 md:px-2",
                levelFilter === level.value ? "bg-surface-2 text-text-primary" : "text-text-secondary hover:text-text-primary",
              )}
            >
              {level.label}
            </button>
          ))}
          <span className="ml-3 self-center text-text-muted">Source:</span>
          {SOURCES.map((source) => (
            <button
              key={source.value}
              type="button"
              onClick={() =>
                navigate({
                  search: (prev: { source?: string; level?: string }) => ({
                    ...prev,
                    source: source.value === "all" ? undefined : source.value,
                  }),
                  replace: true,
                })
              }
              className={cn(
                "min-h-11 rounded-md px-3 py-1 transition-colors md:min-h-8 md:px-2",
                sourceFilter === source.value ? "bg-surface-2 text-text-primary" : "text-text-secondary hover:text-text-primary",
              )}
            >
              {source.label}
            </button>
          ))}
        </div>
      </Card>

      <Card className="p-3">
        {activity.isLoading && <p className="text-sm text-text-muted">Loading audit...</p>}
        {!activity.isLoading && events.length === 0 && <p className="text-sm text-text-muted">No entries match these filters.</p>}
        <ul className="space-y-2 md:space-y-0">
          {events.map((event, index) => (
            <AuditRow key={`${event.timestamp}-${index}`} event={event} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
