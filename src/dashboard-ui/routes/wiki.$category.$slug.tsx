import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/wiki/$category/$slug")({
  component: WikiPageRoute,
});

function WikiPageRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Wiki Page Detail</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
