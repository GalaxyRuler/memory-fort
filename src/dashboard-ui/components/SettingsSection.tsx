import { useId } from "react";
import { type ConfigValue } from "../hooks/useConfig.js";
import { Card } from "./Card.js";
import { SettingsField } from "./SettingsField.js";

export interface SettingsSectionProps {
  title: string;
  data: Record<string, ConfigValue> | undefined;
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
        {Object.entries(data).map(([key, value]) => (
          <SettingsField key={key} label={key} value={value} />
        ))}
      </dl>
    </Card>
  );
}
