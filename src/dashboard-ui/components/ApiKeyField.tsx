import { useEffect, useState } from "react";
import { useSecrets, useUpdateSecret } from "../hooks/useSecrets.js";

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

  // Reset state after a successful save
  useEffect(() => {
    if (update.isSuccess) {
      setEditing(false);
      setValue("");
      setReveal(false);
    }
  }, [update.isSuccess]);

  function submit() {
    if (value.trim().length === 0) return;
    update.mutate({ provider, key: value.trim() });
  }

  return (
    <div className="mt-3">
      <label className="block text-xs font-medium text-text-secondary" htmlFor={`key-${envVar}`}>
        {label}
      </label>
      {showInput ? (
        <div className="mt-1 flex items-center gap-2">
          <input
            id={`key-${envVar}`}
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${label}`}
            className="flex-1 rounded-md border border-border-subtle bg-background px-2 py-1 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button type="button" className="text-xs text-text-muted hover:text-text-primary" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            disabled={update.isPending || value.trim().length === 0}
            className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
            onClick={submit}
          >
            {update.isPending ? "Validating…" : "Save key"}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="font-mono text-text-primary">{"•".repeat(8)}{meta?.last4}</span>
          <button type="button" className="rounded-md border border-border-subtle px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary" onClick={() => setEditing(true)}>
            Replace
          </button>
        </div>
      )}
      {update.error ? (
        <p className="mt-1 text-xs text-status-red">{(update.error as Error).message}</p>
      ) : null}
    </div>
  );
}
