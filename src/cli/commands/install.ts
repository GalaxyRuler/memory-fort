import { installClaudeCode } from "./install/claude-code.js";

export type Platform = "claude-code" | "codex" | "antigravity";

export async function runInstall(platform: string): Promise<void> {
  switch (platform) {
    case "claude-code": {
      const result = await installClaudeCode();
      const banner = result.alreadyInstalled
        ? "Memory plugin for Claude Code already installed"
        : "Installed memory plugin for Claude Code";
      console.log(`${banner} at ${result.pluginDir}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Open Claude Code and run: /plugin marketplace add ~/.memory/claude-code-plugin",
      );
      console.log("     Then: /plugin install memory@local");
      console.log(
        "  2. OR start a session with: claude --plugin-dir ~/.memory/claude-code-plugin",
      );
      console.log(
        "  3. MCP server will be available after step #8 — hooks work now.",
      );
      return;
    }
    case "codex":
      console.error("codex install: implemented in step #9");
      process.exit(2);
    case "antigravity":
      console.error("antigravity install: implemented in step #10");
      process.exit(2);
    default:
      console.error(
        `Unknown platform: ${platform}. Valid: claude-code, codex, antigravity`,
      );
      process.exit(2);
  }
}
