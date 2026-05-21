import { installClaudeCode } from "./install/claude-code.js";
import { installCodex } from "./install/codex.js";

export type Platform = "claude-code" | "codex" | "antigravity";

export async function runInstall(platform: string): Promise<void> {
  switch (platform) {
    case "claude-code": {
      const result = await installClaudeCode();
      console.log(`Installed memory plugin for Claude Code at ${result.pluginDir}`);
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
        `  3. Plugin MCP config is at: ${result.pluginMcpConfigPath}`,
      );
      return;
    }
    case "codex": {
      const result = await installCodex();
      console.log(`Installed memory hooks + MCP for Codex at ${result.codexConfigPath}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Restart any open Codex sessions (desktop or CLI) to pick up the new config.",
      );
      console.log(
        "  2. Both Codex desktop and Codex CLI share ~/.codex/config.toml — one install covers both.",
      );
      console.log("  3. Verify with: codex config show");
      return;
    }
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
