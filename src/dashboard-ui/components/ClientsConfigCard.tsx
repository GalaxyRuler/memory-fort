import { CLIENT_CATALOG, readConfiguredClientEnabled } from "../../clients/catalog.js";
import { classifyClientPresentation } from "../../clients/status.js";
import { useConfig } from "../hooks/useConfig.js";
import { useUpdateConfig } from "../hooks/useUpdateConfig.js";
import { useClientAction, useClientStatuses } from "../hooks/useClientStatus.js";
import { Card } from "./Card.js";

export function ClientsConfigCard() {
  const config = useConfig();
  const update = useUpdateConfig();
  const clientStatuses = useClientStatuses();
  const clientAction = useClientAction();
  const clients = (config.data?.clients ?? {}) as Record<string, boolean>;

  return (
    <Card hasBrackets className="border-border-emphasis">
      <div className="mb-4">
        <h2 className="text-base font-semibold">Clients</h2>
        <p className="text-xs text-text-muted">
          Turn off clients you don&apos;t use. Disabled clients are skipped by supported runtime checks and keep their
          saved setup until you disconnect them.
        </p>
      </div>
      <ul className="space-y-2">
        {CLIENT_CATALOG.map((client) => {
          const enabled = readConfiguredClientEnabled(clients, client.id);
          const status = clientStatuses.data?.find((entry) => entry.client === client.id);
          const presentation = status
            ? classifyClientPresentation(status)
            : enabled ? "Checking…" : "Off";
          const primaryAction = status?.installation === "missing"
            ? "install"
            : status?.installation === "stale"
              ? "repair"
              : null;
          return (
            <li
              key={client.id}
              className={`rounded-md border border-border-subtle px-3 py-2 transition-opacity ${
                enabled ? "" : "opacity-50"
              }`}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                    {client.label}
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                      {client.connection}
                    </span>
                    <span className="rounded bg-text-muted/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                      {presentation}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs text-text-muted">{client.disableEffect}</span>
                  {status?.evidence.length ? <span className="mt-1 block text-xs text-text-muted">{status.evidence[0]}</span> : null}
                </span>
                <span className="flex flex-shrink-0 flex-wrap gap-2 self-start">
                  {primaryAction ? (
                    <button
                      type="button"
                      disabled={clientAction.isPending}
                      className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => clientAction.mutate({ action: primaryAction, client: client.id })}
                    >
                      {primaryAction === "install" ? "Install" : "Repair"}
                    </button>
                  ) : null}
                  {status?.installation && status.installation !== "missing" ? (
                    <button
                      type="button"
                      disabled={clientAction.isPending}
                      className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => clientAction.mutate({ action: "disconnect", client: client.id })}
                    >
                      Disconnect
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${client.label} ${enabled ? "enabled" : "disabled"}`}
                    disabled={update.isPending}
                    className="rounded-md border border-border-subtle px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => update.mutate({ clients: { [client.id]: !enabled } })}
                  >
                    {enabled ? "Turn off" : "Turn on"}
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
