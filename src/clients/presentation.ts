export type ClientName =
  | "claude-code"
  | "claude-desktop"
  | "codex"
  | "antigravity"
  | "antigravity-ide"
  | "chatgpt"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencoven"
  | "opencode"
  | "vscode";

export type ClientInstallation = "missing" | "stale" | "installed";
export type ClientHealth = "unknown" | "healthy" | "unhealthy";

/** Browser-safe view model for client installation and health state. */
export interface ClientIntegrationStatus {
  client: ClientName;
  captureEnabled: boolean;
  installation: ClientInstallation;
  health: ClientHealth;
  lastCheckedAt: string | null;
  evidence: string[];
  configPath?: string;
}

export function classifyClientPresentation(status: ClientIntegrationStatus):
  | "Off"
  | "Not installed"
  | "Needs repair"
  | "Installed — health unknown"
  | "Healthy"
  | "Unhealthy" {
  if (!status.captureEnabled) return "Off";
  if (status.installation === "missing") return "Not installed";
  if (status.installation === "stale") return "Needs repair";
  if (status.health === "healthy") return "Healthy";
  if (status.health === "unhealthy") return "Unhealthy";
  return "Installed — health unknown";
}
