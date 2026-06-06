import { lazy, Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";

const GraphPage = lazy(() => import("../components/GraphPage.js").then((module) => ({ default: module.GraphPage })));

export const Route = createFileRoute("/graph")({
  component: GraphRoute,
});

function GraphRoute() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-text-muted">Loading graph engine...</div>}>
      <GraphPage />
    </Suspense>
  );
}
