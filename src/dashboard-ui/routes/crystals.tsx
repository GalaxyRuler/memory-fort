import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/crystals")({
  component: CrystalsRoute,
});

function CrystalsRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Crystals</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
