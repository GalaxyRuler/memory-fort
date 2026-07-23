import {
  CLIENTS as SHARED_CLIENTS,
  getClientIntegrationStatuses,
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

export async function getClientStatuses(): Promise<ClientStatus[]> {
  const statuses = await getClientIntegrationStatuses();
  return statuses.map((status) => ({
    client: status.client,
    state: status.installation,
    detail: status.evidence.join("; "),
    configPath: status.configPath,
  }));
}

export function formatClientStatus(status: ClientStatus): string {
  const marker = status.state === "installed" ? "✓" : status.state === "stale" ? "⚠" : "✗";
  return `${marker} ${status.client.padEnd(18)} ${status.detail}`;
}
