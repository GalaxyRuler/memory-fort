import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/wiki")({
  component: WikiRoute,
});

function WikiRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Wiki</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
