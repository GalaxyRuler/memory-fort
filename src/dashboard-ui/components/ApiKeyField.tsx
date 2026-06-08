import { useState } from "react";
import { useSecrets, useUpdateSecret } from "../hooks/useSecrets.js";
import { Button } from "./Button.js";
import { Input } from "./Input.js";

export function ApiKeyField({
  provider,
  envVar,
  label,
}: {
  provider: string;
  envVar: string;
  label: string;
}) {
  const secrets = useSecrets();
  const update = useUpdateSecret();
  const meta = secrets.data?.[envVar];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);

  const present = meta?.present === true;
  const showInput = editing || !present;

  function submit() {
    if (value.trim().length === 0) return;
    update.mutate(
      { provider, key: value.trim() },
      {
        onSuccess: () => {
          setEditing(false);
          setValue("");
          setReveal(false);
        },
      },
    );
  }

  return (
    <div className="mt-3">
      <label className="block text-xs font-medium text-text-secondary" htmlFor={`key-${envVar}`}>
        {label}
      </label>
      {showInput ? (
        <div className="mt-1 flex items-center gap-2">
          <Input
            id={`key-${envVar}`}
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${label}`}
            className="flex-1"
          />
          <button
            type="button"
            aria-label={reveal ? "Hide key" : "Show key"}
            className="text-xs text-text-muted hover:text-text-primary"
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? "Hide" : "Show"}
          </button>
          <Button
            type="button"
            variant="secondary"
            disabled={update.isPending || value.trim().length === 0}
            onClick={submit}
          >
            {update.isPending ? "Validating…" : "Save key"}
          </Button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="font-mono text-text-primary">{"•".repeat(8)}{meta?.last4}</span>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditing(true)}
          >
            Replace
          </Button>
        </div>
      )}
      {update.error ? (
        <p className="mt-1 text-xs text-status-red">{(update.error as Error).message}</p>
      ) : null}
    </div>
  );
}
