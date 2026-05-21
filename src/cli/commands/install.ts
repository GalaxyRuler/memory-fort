import { installAntigravity } from "./install/antigravity.js";
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
    case "antigravity": {
      const result = await installAntigravity();
      console.log(`Installed memory MCP for Antigravity at ${result.mcpConfigPath}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Restart Antigravity desktop (or open a new session) to load the memory MCP.",
      );
      console.log(
        "  2. Antigravity has NO hook system — the LLM in your Antigravity session uses the",
      );
      console.log(
        "     memory MCP tools (log_observation, read_page, list_pages) to record + retrieve memory.",
      );
      console.log(
        "  3. Hooks ARE active for Claude Code and Codex sessions if you ran their installs.",
      );
      return;
    }
    default:
      console.error(
        `Unknown platform: ${platform}. Valid: claude-code, codex, antigravity`,
      );
      process.exit(2);
  }
}
