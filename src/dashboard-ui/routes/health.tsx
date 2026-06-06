import { createFileRoute } from "@tanstack/react-router";
import { GraphHealthPanel } from "../components/GraphHealthPanel.js";

export const Route = createFileRoute("/health")({
  component: HealthScreen,
});

function HealthScreen() {
  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="break-words text-2xl font-semibold tracking-tight">Graph Health</h1>
        <p className="text-sm text-text-secondary">
          Drill into graph quality metrics, thresholds, and top offenders.
        </p>
      </header>
      <GraphHealthPanel defaultExpanded persistExpansion={false} detailMode />
    </div>
  );
}
