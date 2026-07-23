import { homedir } from "node:os";
import { join } from "node:path";

export type ToolName =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "claude-desktop"
  | "chatgpt"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencoven"
  | "opencode"
  | "vscode"
  | "manual";
export type PageType =
  | "projects"
  | "issues"
  | "people"
  | "decisions"
  | "lessons"
  | "prospective"
  | "procedures"
  | "threads"
  | "references"
  | "tools"
  | "preferences";

export function memoryRoot(): string {
  const override = process.env["MEMORY_ROOT"];
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".memory");
}

export function schemaPath(): string {
  return join(memoryRoot(), "schema.md");
}

export function indexPath(): string {
  return join(memoryRoot(), "index.md");
}

export function logPath(): string {
  return join(memoryRoot(), "log.md");
}

export function errorsLogPath(): string {
  return join(memoryRoot(), "errors.log");
}

export function configPath(): string {
  return join(memoryRoot(), "config.yaml");
}

export function rawDir(date: Date = new Date(), root?: string): string {
  return join(root ?? memoryRoot(), "raw", formatIsoDate(date));
}

export function rawSessionFile(
  tool: ToolName,
  sessionId: string,
  date: Date = new Date(),
  root?: string,
): string {
  // Filename: <tool>-<safeSessionId>.md
  // sessionId is sanitized: anything outside [A-Za-z0-9._-] becomes '_'
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(rawDir(date, root), `${tool}-${safe}.md`);
}

export function wikiDir(category?: PageType): string {
  const base = join(memoryRoot(), "wiki");
  return category ? join(base, category) : base;
}

export function threadsDir(vaultRoot = memoryRoot()): string {
  return join(vaultRoot, "wiki", "threads");
}

export function threadsProposedDir(vaultRoot = memoryRoot()): string {
  return join(vaultRoot, "wiki", "threads-proposed");
}

export function proceduresDir(vaultRoot = memoryRoot()): string {
  return join(vaultRoot, "wiki", "procedures");
}

export function proceduresProposedDir(vaultRoot = memoryRoot()): string {
  return join(vaultRoot, "wiki", "procedures-proposed");
}

export function crystalsDir(): string {
  return join(memoryRoot(), "crystals");
}

export function scriptsDir(): string {
  return join(memoryRoot(), "scripts");
}

export function mcpServerPath(): string {
  return join(memoryRoot(), "claude-code-plugin", "scripts", "mcp-server.mjs");
}

export function claudeDesktopConfigDir(): string {
  const override = process.env["MEMORY_CLAUDE_DESKTOP_DIR"];
  if (override && override.trim().length > 0) return override;
  const appData = process.env["APPDATA"];
  if (appData) return join(appData, "Claude");
  return join(homedir(), "Library", "Application Support", "Claude");
}

export function claudeDesktopConfigPath(): string {
  return join(claudeDesktopConfigDir(), "claude_desktop_config.json");
}

/**
 * Absolute path to the provider-secrets file. Deliberately OUTSIDE the
 * git-backed vault (~/.memory) so API keys can never be committed/pushed.
 * Priority: $MEMORY_SECRETS_PATH > OS config dir > ~/.config fallback.
 */
export function secretsPath(): string {
  const override = process.env["MEMORY_SECRETS_PATH"];
  if (override && override.trim().length > 0) return override;
  const appData = process.env["APPDATA"]; // Windows
  if (appData) return join(appData, "memory-fort", "secrets.json");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "secrets.json");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "memory-fort", "secrets.json");
  return join(homedir(), ".config", "memory-fort", "secrets.json");
}

/**
 * Path to the persisted scheduler last-run state (per vault, per task).
 * OUTSIDE the vault (operational state, never synced) — and persisted at all
 * because setInterval-based cadences reset on every app restart: a dashboard
 * that restarts more often than daily would otherwise never run its daily
 * tasks. Override with MEMORY_SCHEDULER_STATE_PATH for tests.
 */
export function schedulerStatePath(): string {
  const override = process.env["MEMORY_SCHEDULER_STATE_PATH"]?.trim();
  if (override) return override;
  const appData = process.env["APPDATA"]; // Windows
  if (appData) return join(appData, "memory-fort", "scheduler-state.json");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "scheduler-state.json");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "memory-fort", "scheduler-state.json");
  return join(homedir(), ".config", "memory-fort", "scheduler-state.json");
}

/**
 * Directory for capture events that could not acquire a raw-session lock.
 * Deliberately outside the canonical Markdown vault: spool files are
 * operational recovery state and must never be indexed or committed.
 */
export function captureSpoolDir(): string {
  const override = process.env["MEMORY_CAPTURE_SPOOL_DIR"]?.trim();
  if (override) return override;
  const appData = process.env["APPDATA"];
  if (appData) return join(appData, "memory-fort", "capture-spool");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "capture-spool");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "memory-fort", "capture-spool");
  return join(homedir(), ".config", "memory-fort", "capture-spool");
}

/**
 * Directory containing the self-signed TLS cert+key for the ChatGPT bridge.
 * Stored outside the vault so private keys never enter git.
 * Override with MEMORY_CHATGPT_BRIDGE_CERT_DIR for tests / isolated installs.
 */
export function chatgptBridgeCertDir(): string {
  const override = process.env["MEMORY_CHATGPT_BRIDGE_CERT_DIR"]?.trim();
  if (override) return override;
  const appData = process.env["APPDATA"]; // Windows
  if (appData) return join(appData, "memory-fort", "chatgpt-bridge-cert");
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "memory-fort", "chatgpt-bridge-cert");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.trim().length > 0) return join(xdg, "memory-fort", "chatgpt-bridge-cert");
  return join(homedir(), ".config", "memory-fort", "chatgpt-bridge-cert");
}

/**
 * Path to the PID file for the running ChatGPT bridge process.
 * Deliberately OUTSIDE the git-backed vault so it never blocks auto-commit.
 * Uses LOCALAPPDATA on Windows, XDG_RUNTIME_DIR or /tmp elsewhere.
 * Override with MEMORY_CHATGPT_BRIDGE_PID_PATH for tests / isolated installs.
 */
export function chatgptBridgePidPath(): string {
  const override = process.env["MEMORY_CHATGPT_BRIDGE_PID_PATH"]?.trim();
  if (override) return override;
  const localAppData = process.env["LOCALAPPDATA"]; // Windows
  if (localAppData) return join(localAppData, "memory-fort", "chatgpt-bridge.pid");
  const xdgRuntime = process.env["XDG_RUNTIME_DIR"];
  if (xdgRuntime && xdgRuntime.trim().length > 0) return join(xdgRuntime, "memory-fort", "chatgpt-bridge.pid");
  return join(homedir(), ".local", "state", "memory-fort", "chatgpt-bridge.pid");
}

export function formatIsoDate(date: Date): string {
  // YYYY-MM-DD in UTC to avoid TZ drift across machines
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
