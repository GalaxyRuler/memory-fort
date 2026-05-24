import { type ConfigValue } from "../hooks/useConfig.js";
import { Card } from "./Card.js";
import { SettingsField } from "./SettingsField.js";

export interface SettingsSectionProps {
  title: string;
  data: Record<string, ConfigValue> | undefined;
}

export function SettingsSection({ title, data }: SettingsSectionProps) {
  if (!data || Object.keys(data).length === 0) return null;

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold capitalize tracking-tight">{title.replace(/_/g, " ")}</h2>
      <dl>
        {Object.entries(data).map(([key, value]) => (
          <SettingsField key={key} label={key} value={value} />
        ))}
      </dl>
    </Card>
  );
}
