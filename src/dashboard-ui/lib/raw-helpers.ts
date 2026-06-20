export const RAW_SOURCES = [
  "claude-code",
  "codex",
  "antigravity",
  "claude-desktop",
  "chatgpt",
  "hermes",
  "pi",
  "openclaw",
  "opencode",
  "opencoven",
  "vscode",
  "manual",
  "unknown",
] as const;

export type RawSource = (typeof RAW_SOURCES)[number];

export function parseSourceFromFilename(filename: string): RawSource {
  if (filename.startsWith("claude-code-")) return "claude-code";
  if (filename.startsWith("codex-")) return "codex";
  if (filename.startsWith("antigravity-")) return "antigravity";
  if (filename.startsWith("claude-desktop-")) return "claude-desktop";
  if (filename.startsWith("chatgpt-")) return "chatgpt";
  if (filename.startsWith("hermes-")) return "hermes";
  if (filename.startsWith("pi-")) return "pi";
  if (filename.startsWith("openclaw-")) return "openclaw";
  if (filename.startsWith("opencode-")) return "opencode";
  if (filename.startsWith("opencoven-")) return "opencoven";
  if (filename.startsWith("vscode-")) return "vscode";
  if (filename.startsWith("manual-mcp-") || filename.startsWith("manual-")) return "manual";
  return "unknown";
}

export function parseSessionIdFromFilename(filename: string): string {
  const noExt = filename.replace(/\.md$/, "");
  const prefixes = [
    "claude-code-agent-",
    "claude-code-",
    "codex-",
    "antigravity-",
    "claude-desktop-",
    "chatgpt-",
    "hermes-",
    "pi-",
    "openclaw-",
    "opencode-",
    "opencoven-",
    "vscode-",
    "manual-mcp-",
    "manual-",
  ];
  for (const prefix of prefixes) {
    if (noExt.startsWith(prefix)) return noExt.slice(prefix.length);
  }
  return noExt;
}

const SOURCE_COLORS: Record<RawSource, string> = {
  "claude-code": "bg-entity-projects",
  codex: "bg-entity-decisions",
  antigravity: "bg-entity-tools",
  "claude-desktop": "bg-entity-tools",
  chatgpt: "bg-entity-tools",
  hermes: "bg-entity-tools",
  pi: "bg-entity-decisions",
  openclaw: "bg-entity-projects",
  opencode: "bg-entity-projects",
  opencoven: "bg-entity-tools",
  vscode: "bg-entity-decisions",
  manual: "bg-text-muted",
  unknown: "bg-text-muted",
};

export function sourceColorClass(source: RawSource): string {
  return SOURCE_COLORS[source];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
