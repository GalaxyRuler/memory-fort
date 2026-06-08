import { useConfig } from "../hooks/useConfig.js";
import { useUpdateConfig } from "../hooks/useUpdateConfig.js";

const TOGGLEABLE_CLIENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "opencoven", label: "OpenCoven" },
];

export function ClientsConfigCard() {
  const config = useConfig();
  const update = useUpdateConfig();
  const clients = (config.data?.clients ?? {}) as Record<string, boolean>;

  return (
    <section className="rounded-lg border border-border-subtle bg-surface p-4">
      <h2 className="text-base font-semibold text-text-primary">Clients</h2>
      <p className="mt-1 text-sm text-text-secondary">
        Turn off clients you don&apos;t use. Disabled clients stop appearing in
        health checks; capture is unaffected.
      </p>
      <ul className="mt-3 space-y-2">
        {TOGGLEABLE_CLIENTS.map(({ id, label }) => {
          const enabled = clients[id] !== false;
          return (
            <li
              key={id}
              className={`flex items-center justify-between rounded-md border border-border-subtle px-3 py-2 transition-opacity ${
                enabled ? "" : "opacity-50"
              }`}
            >
              <span className="flex items-center gap-2 text-sm text-text-primary">
                {label}
                {!enabled ? (
                  <span className="rounded bg-text-muted/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                    Off
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={`${label} ${enabled ? "enabled" : "disabled"}`}
                disabled={update.isPending}
                className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => update.mutate({ clients: { [id]: !enabled } })}
              >
                {enabled ? "Turn off" : "Turn on"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
