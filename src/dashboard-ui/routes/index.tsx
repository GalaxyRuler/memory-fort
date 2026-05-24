import { createFileRoute } from "@tanstack/react-router";
import { NeedsAttention } from "../components/NeedsAttention.js";
import { RecentActivity } from "../components/RecentActivity.js";
import { StatCard } from "../components/StatCard.js";
import { useActivity } from "../hooks/useActivity.js";
import { useStatus } from "../hooks/useStatus.js";

export const Route = createFileRoute("/")({
  component: OverviewScreen,
});

function OverviewScreen() {
  const status = useStatus();
  const activity = useActivity(20);
  const counts = status.data?.counts;

  const wikiSpark = Array(5).fill(counts?.wikiPages ?? 0) as number[];
  const rawSpark = Array(5).fill(counts?.rawObservations ?? 0) as number[];

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="text-sm text-text-secondary">System telemetry and recent cognitive activity.</p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <RecentActivity events={activity.data?.events} isLoading={activity.isLoading} />
        </div>

        <div className="space-y-4 md:col-span-1">
          <h2 className="text-xs uppercase tracking-wider text-text-muted">At a Glance</h2>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Wiki pages"
              value={counts?.wikiPages ?? "-"}
              sparkline={wikiSpark}
              sparklineColor="rgb(91 139 255 / 0.7)"
            />
            <StatCard
              label="Raw observations"
              value={counts?.rawObservations ?? "-"}
              sparkline={rawSpark}
              sparklineColor="rgb(91 139 255 / 0.7)"
            />
            <StatCard
              label="Last compile"
              value={status.data?.lastCompile ? "ok" : "-"}
              footer={status.data?.lastCompile?.timestamp.slice(0, 10) ?? "never"}
            />
            <StatCard
              label="Errors log"
              value={status.data ? (status.data.errorsLog.isClean ? "clean" : "issues") : "-"}
              sparklineColor={
                status.data?.errorsLog.isClean ? "rgb(74 222 128 / 0.7)" : "rgb(248 113 113 / 0.7)"
              }
            />
          </div>
        </div>

        <div className="md:col-span-1">
          <NeedsAttention status={status.data} />
        </div>
      </div>
    </div>
  );
}
