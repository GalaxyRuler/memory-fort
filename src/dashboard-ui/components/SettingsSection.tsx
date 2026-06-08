import { useId } from "react";
import { type ConfigValue } from "../hooks/useConfig.js";
import { Card } from "./Card.js";
import { SettingsField } from "./SettingsField.js";

export interface SettingsSectionProps {
  title: string;
  data: Record<string, ConfigValue> | undefined;
}

function yesNo(value: ConfigValue): string {
  return value === true ? "Yes" : "No";
}

function getRetentionLabel(key: string, value: ConfigValue): string | null {
  switch (key) {
    case "raw_window_days":
      return `Keep raw sessions for ${String(value)} days`;
    case "raw_compile_before_delete":
      return `Compile before deleting raw sessions: ${yesNo(value)}`;
    case "embeddings_prune_with_raw":
      return `Prune embeddings with raw sessions: ${yesNo(value)}`;
    case "wiki_status_stale_days":
      return `Mark wiki pages stale after ${String(value)} days`;
    case "crystals_never_auto_delete":
      return `Never auto-delete crystals: ${yesNo(value)}`;
    default:
      return null;
  }
}

function RetentionField({ rawKey, label }: { rawKey: string; label: string }) {
  return (
    <div className="grid grid-cols-1 border-b border-border-subtle/60 py-2 last:border-b-0">
      <dt className="min-w-0">
        <span className="block break-words text-sm font-medium text-text-primary">{label}</span>
        <code
          className="mt-1 block break-all font-mono text-xs uppercase tracking-wider text-text-muted"
          title={`Raw config key: ${rawKey}`}
        >
          {rawKey}
        </code>
      </dt>
      <dd className="sr-only">Raw config key: {rawKey}</dd>
    </div>
  );
}

export function SettingsSection({ title, data }: SettingsSectionProps) {
  const titleId = useId();
  if (!data || Object.keys(data).length === 0) return null;

  return (
    <Card aria-labelledby={titleId} role="group" tabIndex={0}>
      <h2 id={titleId} className="mb-3 text-base font-semibold capitalize tracking-tight">
        {title.replace(/_/g, " ")}
      </h2>
      <dl>
        {Object.entries(data).map(([key, value]) => {
          const retentionLabel = title === "retention" ? getRetentionLabel(key, value) : null;
          if (retentionLabel) return <RetentionField key={key} rawKey={key} label={retentionLabel} />;
          return <SettingsField key={key} label={key} value={value} />;
        })}
      </dl>
    </Card>
  );
}
