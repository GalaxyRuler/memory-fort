import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/activity")({
  component: ActivityRoute,
});

function ActivityRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Activity</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
