import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/raw/$date/$filename")({
  component: RawSessionRoute,
});

function RawSessionRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Raw Session Detail</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
