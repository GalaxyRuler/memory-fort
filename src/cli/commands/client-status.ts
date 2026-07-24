import {
  CLIENTS as SHARED_CLIENTS,
  getClientIntegrationStatuses,
  type ClientStatusOptions,
  type ClientInstallation,
  type ClientName,
} from "../../clients/status.js";

export type { ClientName } from "../../clients/status.js";
export type ClientInstallState = ClientInstallation;

/** Backwards-compatible CLI projection of the shared client status contract. */
export interface ClientStatus {
  client: ClientName;
  state: ClientInstallState;
  detail: string;
  configPath?: string;
}

export const CLIENTS: ClientName[] = SHARED_CLIENTS;

export async function getClientStatuses(opts: ClientStatusOptions = {}): Promise<ClientStatus[]> {
  // The CLI is the operator-facing status surface, so it performs the bounded
  // protocol probe rather than returning an installation-only guess.
  const statuses = await getClientIntegrationStatuses({ ...opts, probeMcp: true });
  return statuses.map((status) => ({
    client: status.client,
    state: status.installation,
    // Preserve the concise legacy CLI summary; the shared status object carries
    // the probe evidence separately for callers that render it.
    detail: status.evidence[0] ?? "not installed",
    configPath: status.configPath,
  }));
}

export function formatClientStatus(status: ClientStatus): string {
  const marker = status.state === "installed" ? "✓" : status.state === "stale" ? "⚠" : "✗";
  return `${marker} ${status.client.padEnd(18)} ${status.detail}`;
}
