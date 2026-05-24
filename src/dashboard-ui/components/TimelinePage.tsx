import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTimeline, type TimelineZoom } from "../hooks/useTimeline.js";
import { cn } from "../lib/cn.js";
import { Card } from "./Card.js";
import { TimelineChart } from "./TimelineChart.js";

const ZOOM_OPTIONS: TimelineZoom[] = ["1H", "1D", "1W", "1M", "1Y"];

function readZoom(value: string | undefined): TimelineZoom {
  return ZOOM_OPTIONS.includes(value as TimelineZoom) ? (value as TimelineZoom) : "1D";
}

export function TimelinePage() {
  const params = useSearch({ from: "/timeline" }) as { zoom?: string };
  const navigate = useNavigate({ from: "/timeline" });
  const zoom = readZoom(params.zoom);
  const timeline = useTimeline({ zoom });

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Timeline</h1>
          <p className="text-sm text-text-secondary">
            {timeline.data
              ? `${new Date(timeline.data.from).toLocaleString()} -> ${new Date(timeline.data.to).toLocaleString()}`
              : "Loading..."}
          </p>
        </div>
        <div className="flex gap-1">
          {ZOOM_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => navigate({ search: { zoom: option === "1D" ? undefined : option }, replace: true })}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-mono transition-colors",
                zoom === option
                  ? "bg-surface-2 text-text-primary"
                  : "text-text-secondary hover:text-text-primary hover:bg-surface-2/50",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </header>

      <Card>
        {timeline.isLoading && <p className="text-sm text-text-muted">Loading timeline...</p>}
        {timeline.data && <TimelineChart data={timeline.data} />}
      </Card>
    </div>
  );
}
