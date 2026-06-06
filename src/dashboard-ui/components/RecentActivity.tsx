import type { ActivityEvent } from "../hooks/useActivity.js";
import { Card } from "./Card.js";

const SOURCE_COLOR: Record<ActivityEvent["source"], string> = {
  git: "bg-status-blue",
  compile: "bg-entity-decisions",
  sync: "bg-status-green",
  lint: "bg-entity-lessons",
  errors: "bg-status-red",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function RecentActivity({
  events,
  isLoading,
}: {
  events: ActivityEvent[] | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <div className="text-sm text-text-muted">Loading...</div>
      </Card>
    );
  }

  if (!events || events.length === 0) {
    return (
      <Card>
        <div className="text-sm text-text-muted">No recent activity.</div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="mb-3 text-xs uppercase tracking-wider text-text-muted">Recent Activity</h2>
      <ul className="space-y-2">
        {events.map((event, index) => (
          <li key={`${event.timestamp}-${index}`} className="flex items-start gap-2.5 text-sm">
            <span
              className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${SOURCE_COLOR[event.source]}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="break-words text-text-primary md:truncate">{event.summary}</p>
              <p className="text-xs text-text-muted">{relativeTime(event.timestamp)}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
