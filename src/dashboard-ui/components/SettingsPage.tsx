import { FileText, Terminal } from "lucide-react";
import { type ConfigValue, useConfig } from "../hooks/useConfig.js";
import { Card } from "./Card.js";
import { EmbedderConfigCard } from "./EmbedderConfigCard.js";
import { LLMConfigCard } from "./LLMConfigCard.js";
import { SettingsSection } from "./SettingsSection.js";

function isSection(value: ConfigValue): value is Record<string, ConfigValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function SettingsPage() {
  const config = useConfig();

  if (config.isLoading) return <div className="p-4 text-sm text-text-muted md:p-6">Loading settings...</div>;
  if (config.error || !config.data) return <div className="p-4 text-sm text-status-red md:p-6">Failed to load config.</div>;

  const entries = Object.entries(config.data);
  const sections = entries.filter(([, value]) => isSection(value));
  const scalars = entries.filter(([, value]) => !isSection(value));
  const generalData = Object.fromEntries(scalars) as Record<string, ConfigValue>;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <header className="mb-6">
        <h1 className="break-words text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-text-secondary">
          Provider settings can be edited here. Other fields are a read-only view of{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">~/.memory/config.yaml</code>.
        </p>
      </header>

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <EmbedderConfigCard />
          <LLMConfigCard />
        </div>

        {scalars.length > 0 && <SettingsSection title="general" data={generalData} />}
        {sections.map(([sectionKey, sectionValue]) => (
          <SettingsSection key={sectionKey} title={sectionKey} data={sectionValue as Record<string, ConfigValue>} />
        ))}

        <Card className="border-border-emphasis">
          <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
            <Terminal size={16} strokeWidth={1.5} />
            Editing settings
          </h2>
          <p className="mb-3 text-sm text-text-secondary">
            Provider settings (embedder + LLM) can now be edited directly via the cards above. Other config fields
            remain read-only. To edit retention, privacy, or other fields, open{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">~/.memory/config.yaml</code> on your
            creator machine.
          </p>
          <div className="flex items-start gap-2 rounded-md bg-surface-2 p-3 font-mono text-xs text-text-primary">
            <FileText size={14} strokeWidth={1.5} className="flex-shrink-0 text-text-muted" />
            <code className="break-all">code "C:/Users/Admin/.memory/config.yaml"</code>
          </div>
          <p className="mt-3 text-xs text-text-muted">
            Changes sync to the VPS within about 5 seconds via the auto-push hook. The dashboard picks up the new
            config on the next page load.
          </p>
        </Card>

        <Card className="border-status-amber/30 bg-status-amber/5">
          <h2 className="mb-2 text-base font-semibold text-status-amber">Voyage API key</h2>
          <p className="text-sm text-text-secondary">
            The Voyage API key is stored separately at{" "}
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
              /root/memory-system/env/voyage.env
            </code>{" "}
            on the VPS. It is never exposed through the API. The dashboard shows{" "}
            <code className="font-mono text-xs">[REDACTED]</code> if it appears in config.
          </p>
        </Card>
      </div>
    </div>
  );
}
