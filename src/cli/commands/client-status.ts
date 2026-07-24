import {
  CLIENTS as SHARED_CLIENTS,
  getClientIntegrationStatuses,
  type ClientHealth,
  type ClientStatusOptions,
  type ClientInstallation,
  type ClientName,
} from "../../clients/status.js";

export type { ClientName } from "../../clients/status.js";
export type ClientInstallState = ClientInstallation;

/** Backwards-compatible CLI projection of the shared client status contract. */
export interface ClientStatus {
  client: ClientName;
  captureEnabled: boolean;
  state: ClientInstallState;
  health: ClientHealth;
  lastCheckedAt: string | null;
  evidence: string[];
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
    captureEnabled: status.captureEnabled,
    state: status.installation,
    health: status.health,
    lastCheckedAt: status.lastCheckedAt,
    evidence: status.evidence,
    detail: status.evidence.join("; ") || "not installed",
    configPath: status.configPath,
  }));
}

export function formatClientStatus(status: ClientStatus): string {
  const marker = !status.captureEnabled
    ? "○"
    : status.state === "missing"
      ? "✗"
      : status.state === "stale" || status.health === "unhealthy"
        ? "⚠"
        : status.health === "healthy"
          ? "✓"
          : "?";
  const installation = status.state === "installed" ? "Installed" : status.state === "stale" ? "Stale" : "Missing";
  const health = status.health === "healthy" ? "Healthy" : status.health === "unhealthy" ? "Unhealthy" : "Unknown";
  return `${marker} ${status.client.padEnd(18)} Capture: ${status.captureEnabled ? "on" : "off"} | Installation: ${installation} | Health: ${health} — ${status.detail}`;
}
