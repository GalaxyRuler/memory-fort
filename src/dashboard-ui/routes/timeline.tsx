import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/timeline")({
  component: TimelineRoute,
});

function TimelineRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Timeline</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
