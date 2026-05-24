import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsRoute,
});

function SettingsRoute() {
  return (
    <section className="space-y-2 p-6">
      <h2 className="text-2xl font-semibold">Settings</h2>
      <p className="text-text-secondary">Stub - populated in later slice.</p>
    </section>
  );
}
