export type RawSource = "claude-code" | "codex" | "antigravity" | "manual" | "unknown";

export function parseSourceFromFilename(filename: string): RawSource {
  if (filename.startsWith("claude-code-")) return "claude-code";
  if (filename.startsWith("codex-")) return "codex";
  if (filename.startsWith("antigravity-")) return "antigravity";
  if (filename.startsWith("manual-mcp-") || filename.startsWith("manual-")) return "manual";
  return "unknown";
}

export function parseSessionIdFromFilename(filename: string): string {
  const noExt = filename.replace(/\.md$/, "");
  const prefixes = ["claude-code-", "codex-", "antigravity-", "manual-mcp-", "manual-"];
  for (const prefix of prefixes) {
    if (noExt.startsWith(prefix)) return noExt.slice(prefix.length);
  }
  return noExt;
}

const SOURCE_COLORS: Record<RawSource, string> = {
  "claude-code": "bg-entity-projects",
  codex: "bg-entity-decisions",
  antigravity: "bg-entity-tools",
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
