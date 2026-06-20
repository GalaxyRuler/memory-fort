export interface ClientCatalogEntry {
  id: string;
  label: string;
  connection: string;
  defaultEnabled: boolean;
  disableEffect: string;
  disconnectCommand: string;
}

export const CLIENT_CATALOG = [
  {
    id: "claude-code",
    label: "Claude Code",
    connection: "Hooks + MCP",
    defaultEnabled: true,
    disableEffect: "Skips Claude Code hook capture, session context, and verify checks.",
    disconnectCommand: "memory-fort disconnect claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    connection: "Hooks + MCP",
    defaultEnabled: true,
    disableEffect: "Skips Codex hook capture, session context, and verify checks.",
    disconnectCommand: "memory-fort disconnect codex",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    connection: "MCP + live-capture plugin",
    defaultEnabled: true,
    disableEffect: "Skips Antigravity verify checks; disconnect removes the shared workspace/IDE config.",
    disconnectCommand: "memory-fort disconnect antigravity",
  },
  {
    id: "hermes",
    label: "Hermes",
    connection: "YAML hooks + MCP",
    defaultEnabled: true,
    disableEffect: "Keeps Hermes out of configured client availability decisions.",
    disconnectCommand: "memory-fort disconnect hermes",
  },
  {
    id: "pi",
    label: "Pi",
    connection: "YAML hooks",
    defaultEnabled: true,
    disableEffect: "Keeps Pi out of configured client availability decisions.",
    disconnectCommand: "memory-fort disconnect pi",
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    connection: "MCP only",
    defaultEnabled: true,
    disableEffect: "Blocks source-tagged OpenClaw MCP observations when disabled.",
    disconnectCommand: "memory-fort disconnect openclaw",
  },
  {
    id: "opencoven",
    label: "OpenCoven",
    connection: "Read-only readiness",
    defaultEnabled: true,
    disableEffect: "Skips OpenCoven readiness checks.",
    disconnectCommand: "memory-fort disconnect opencoven",
  },
  {
    id: "opencode",
    label: "OpenCode",
    connection: "MCP + event plugin",
    defaultEnabled: true,
    disableEffect: "Skips OpenCode event capture and verify checks.",
    disconnectCommand: "memory-fort disconnect opencode",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    connection: "MCP only",
    defaultEnabled: true,
    disableEffect: "Skips Claude Desktop MCP/watcher verify checks and blocks source-tagged observations.",
    disconnectCommand: "memory-fort disconnect claude-desktop",
  },
  {
    id: "vscode",
    label: "VS Code",
    connection: "MCP + extension shell",
    defaultEnabled: true,
    disableEffect: "Skips VS Code MCP/extension verify checks and blocks source-tagged observations.",
    disconnectCommand: "memory-fort disconnect vscode",
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    connection: "HTTP/SSE bridge",
    defaultEnabled: false,
    disableEffect: "Stops ChatGPT bridge verify checks and blocks source-tagged observations.",
    disconnectCommand: "memory-fort disconnect chatgpt",
  },
] as const satisfies readonly ClientCatalogEntry[];

export type ConfigurableClientId = (typeof CLIENT_CATALOG)[number]["id"];

export const CONFIGURABLE_CLIENT_IDS = CLIENT_CATALOG.map((client) => client.id) as ConfigurableClientId[];

export function isConfigurableClientId(value: unknown): value is ConfigurableClientId {
  return typeof value === "string" && CONFIGURABLE_CLIENT_IDS.includes(value as ConfigurableClientId);
}

export function clientEnabledByDefault(id: string): boolean {
  return CLIENT_CATALOG.find((client) => client.id === id)?.defaultEnabled ?? true;
}

export function readConfiguredClientEnabled(
  clients: Record<string, boolean> | undefined,
  id: string,
): boolean {
  return clients?.[id] ?? clientEnabledByDefault(id);
}
