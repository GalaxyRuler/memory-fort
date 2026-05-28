import { FileCog, FileText, Inbox, Terminal } from "lucide-react";
import { type ConfigValue, useConfig } from "../hooks/useConfig.js";
import { useUpdateConfig } from "../hooks/useUpdateConfig.js";
import { Card } from "./Card.js";
import { EmbedderConfigCard } from "./EmbedderConfigCard.js";
import { LLMConfigCard } from "./LLMConfigCard.js";
import { SettingsSection } from "./SettingsSection.js";

function isSection(value: ConfigValue): value is Record<string, ConfigValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const DEDICATED_PROVIDER_SECTIONS = new Set(["embedder", "embedding", "llm", "auto_promote", "compile"]);

export function SettingsPage() {
  const config = useConfig();

  if (config.isLoading) return <div className="p-4 text-sm text-text-muted md:p-6">Loading settings...</div>;
  if (config.error || !config.data) return <div className="p-4 text-sm text-status-red md:p-6">Failed to load config.</div>;

  const entries = Object.entries(config.data);
  const sections = entries.filter(([key, value]) => isSection(value) && !DEDICATED_PROVIDER_SECTIONS.has(key));
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
        <AutoPromoteConfigCard autoPromote={config.data.auto_promote} />
        <CompileConfigCard compile={config.data.compile} />

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

function CompileConfigCard({ compile }: { compile: ConfigValue | undefined }) {
  const updateConfig = useUpdateConfig();
  const section = isSection(compile) ? compile : {};
  const scheduled = section.scheduled !== false;
  const cadence = section.cadence === "weekly" || section.cadence === "manual" ? section.cadence : "daily";

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <FileCog size={16} strokeWidth={1.5} />
            Compile
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Scheduled consolidation prompt generation for raw observations.
          </p>
        </div>
        <a href="/memory/compile" className="text-sm font-medium text-primary hover:underline">
          View compile
        </a>
      </div>

      <label className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2 p-3">
        <span>
          <span className="block text-sm font-medium">Schedule compile</span>
          <span className="block text-xs text-text-muted">Runs inside the dashboard scheduler.</span>
        </span>
        <input
          type="checkbox"
          checked={scheduled}
          disabled={updateConfig.isPending}
          onChange={(event) => updateConfig.mutate({ compile: { scheduled: event.target.checked } })}
          className="h-5 w-5 accent-primary"
        />
      </label>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Cadence</legend>
        <div className="flex flex-wrap gap-2">
          {(["daily", "weekly", "manual"] as const).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name="compile-cadence"
                checked={cadence === option}
                disabled={updateConfig.isPending}
                onChange={() => updateConfig.mutate({ compile: { cadence: option } })}
                className="accent-primary"
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      {updateConfig.error && (
        <p className="mt-3 text-sm text-status-red">{updateConfig.error.message}</p>
      )}
    </Card>
  );
}

function AutoPromoteConfigCard({ autoPromote }: { autoPromote: ConfigValue | undefined }) {
  const updateConfig = useUpdateConfig();
  const section = isSection(autoPromote) ? autoPromote : {};
  const enabled = section.enabled === true;
  const cadence = section.cadence === "daily" || section.cadence === "manual" ? section.cadence : "weekly";

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Inbox size={16} strokeWidth={1.5} />
            Auto-promote
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            High-confidence proposal runs can promote clean drafts automatically.
          </p>
        </div>
        <a href="/memory/inbox" className="text-sm font-medium text-primary hover:underline">
          View inbox
        </a>
      </div>

      <label className="mb-4 flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface-2 p-3">
        <span>
          <span className="block text-sm font-medium">Enable auto-promote</span>
          <span className="block text-xs text-text-muted">Runs only inside the dashboard process.</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={updateConfig.isPending}
          onChange={(event) => updateConfig.mutate({ auto_promote: { enabled: event.target.checked } })}
          className="h-5 w-5 accent-primary"
        />
      </label>

      <fieldset className="mb-4">
        <legend className="mb-2 text-sm font-medium">Cadence</legend>
        <div className="flex flex-wrap gap-2">
          {(["weekly", "daily", "manual"] as const).map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-sm"
            >
              <input
                type="radio"
                name="auto-promote-cadence"
                checked={cadence === option}
                disabled={updateConfig.isPending}
                onChange={() => updateConfig.mutate({ auto_promote: { cadence: option } })}
                className="accent-primary"
              />
              {option}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-md bg-surface-2 p-3 text-sm text-text-secondary">
        <span className="font-medium text-text-primary">Confidence threshold:</span>{" "}
        high. Clean drafts need zero stripped references, zero prose path leaks, zero stripped commands,
        at least 5 observations, and at least 2 sessions.
      </div>
      {updateConfig.error && (
        <p className="mt-3 text-sm text-status-red">{updateConfig.error.message}</p>
      )}
    </Card>
  );
}
