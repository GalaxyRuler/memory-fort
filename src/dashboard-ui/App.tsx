import { Button } from "./components/Button.js";
import { Card } from "./components/Card.js";
import { EntityIcon, type EntityType } from "./components/EntityIcon.js";
import { GlassPanel } from "./components/GlassPanel.js";
import { Input } from "./components/Input.js";
import { StatusPill } from "./components/StatusPill.js";

const entityTypes: EntityType[] = [
  "projects",
  "decisions",
  "lessons",
  "references",
  "tools",
  "people",
  "crystals",
  "raw-session",
];

export function App() {
  return (
    <div className="min-h-screen space-y-6 p-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">memory</h1>
        <p className="text-text-secondary">Phase 4 - SPA dashboard scaffold</p>
      </header>

      <Card>
        <h2 className="mb-3 text-lg font-semibold">Component preview</h2>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {entityTypes.map((type) => (
              <EntityIcon key={type} type={type} size="lg" />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusPill kind="active" />
            <StatusPill kind="superseded" />
            <StatusPill kind="archived" />
            <StatusPill kind="synced" />
            <StatusPill kind="conflict" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary">Primary action</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
          <Input placeholder="Themed input field" className="w-full max-w-sm" />
        </div>
      </Card>

      <GlassPanel className="max-w-sm">
        <h3 className="mb-1 text-sm font-semibold">Glass panel</h3>
        <p className="text-xs text-text-secondary">
          backdrop-filter blur + saturate, gradient border on hover
        </p>
      </GlassPanel>
    </div>
  );
}
