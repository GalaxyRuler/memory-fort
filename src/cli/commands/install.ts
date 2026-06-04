import { homedir } from "node:os";
import { join } from "node:path";
import { installAntigravity } from "./install/antigravity.js";
import { installClaudeCode, claudeCodeSettingsPath } from "./install/claude-code.js";
import { runInstallClaudeDesktop } from "./install/claude-desktop.js";
import { installCodex } from "./install/codex.js";
import { installVsCode, vscodeExtensionDir, vscodeMcpConfigPath } from "./install/vscode.js";
import { formatVerifyResult, runVerify, type VerifyResult } from "./verify.js";
import { claudeDesktopConfigPath, logPath, memoryRoot } from "../../storage/paths.js";
import { guardWrites, type CommandStdout, type ConfirmPrompt } from "./write-guard.js";

export type Platform =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "claude-desktop"
  | "vscode";

export interface RunInstallOptions {
  workspace?: string;
  surface?: "workspace" | "ide" | "both";
  noVerify?: boolean;
  verifyFn?: () => Promise<VerifyResult>;
  dryRun?: boolean;
  yes?: boolean;
  stdout?: CommandStdout;
  confirm?: ConfirmPrompt;
  vscodeExtensionDir?: string;
}

export async function runInstall(
  platform: string,
  opts: RunInstallOptions = {},
): Promise<void> {
  const planned = planInstallWrites(platform, opts);
  if (!planned) {
    console.error(
      `Unknown platform: ${platform}. Valid: claude-code, codex, antigravity, claude-desktop, vscode`,
    );
    process.exit(2);
  }
  const guard = await guardWrites({
    command: `memory install ${platform}`,
    planned,
    dryRun: opts.dryRun,
    yes: opts.yes,
    stdout: opts.stdout,
    confirm: opts.confirm,
  });
  if (!guard.shouldWrite) return;

  switch (platform) {
    case "claude-code": {
      const result = await installClaudeCode();
      console.log(`Installed memory plugin for Claude Code at ${result.pluginDir}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Restart Claude Code or start a new session to load the plugin.");
      console.log(
        `  2. Confirm ${result.enabledPluginKey} is enabled in ${result.settingsPath}.`,
      );
      console.log(
        `  3. Plugin MCP config is at: ${result.pluginMcpConfigPath}`,
      );
      await printVerify(opts);
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
      await printVerify(opts);
      return;
    }
    case "antigravity": {
      const result = await installAntigravity({ surface: opts.surface });
      console.log(
        result.livePluginInstalled
          ? `Installed memory MCP + live-capture plugin for Antigravity at ${result.mcpConfigPath}`
          : `Installed memory MCP for Antigravity at ${result.mcpConfigPath}`,
      );
      for (const line of result.log) console.log(`  ${line}`);
      console.log(`  surfaces: ${result.surfaces.join(", ")}`);
      console.log("");
      console.log("Next steps:");
      console.log(
        "  1. Restart Antigravity desktop (or open a new session) to load the memory integration.",
      );
      console.log(
        result.livePluginInstalled
          ? "  2. Live capture uses the installed plugin hooks; MCP tools remain available for explicit memory actions."
          : "  2. This Antigravity version was too old for live hooks; MCP tools remain available for explicit memory actions.",
      );
      console.log(
        "  3. Verify new captures under ~/.memory/raw after the next Antigravity session.",
      );
      await printVerify(opts);
      return;
    }
    case "vscode": {
      const result = await installVsCode({ workspace: opts.workspace });
      if (result.status === "skipped") {
        console.log(result.reason);
        return;
      }
      console.log(`Installed memory MCP for VS Code at ${result.configPath}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Restart VS Code or run 'MCP: List Servers' from the Command Palette.");
      console.log("  2. Confirm the memory server is listed.");
      await printVerify(opts);
      return;
    }
    case "claude-desktop": {
      const result = await runInstallClaudeDesktop();
      console.log(`Installed memory MCP for Claude Desktop at ${result.configPath}`);
      for (const line of result.log) console.log(`  ${line}`);
      console.log(`  memory MCP entry ${result.memoryEntryAction}`);
      console.log(`  preserved ${result.preservedServerCount} other MCP server(s)`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Restart Claude Desktop to load the memory MCP server.");
      console.log(
        "  2. Open Settings → Developer → MCP Servers and confirm memory is listed.",
      );
      console.log(
        "  3. Claude Desktop is MCP-only — no hooks are installed for passive capture.",
      );
      await printVerify(opts);
      return;
    }
    default:
      process.exit(2);
  }
}

export function planInstallWrites(
  platform: string,
  opts: Pick<RunInstallOptions, "workspace" | "vscodeExtensionDir"> = {},
): string[] | null {
  switch (platform) {
    case "claude-code": {
      const root = memoryRoot();
      const pluginDir = join(root, "claude-code-plugin");
      return [
        join(pluginDir, ".claude-plugin", "plugin.json"),
        join(root, ".claude-plugin", "marketplace.json"),
        join(pluginDir, "hooks", "hooks.json"),
        join(pluginDir, "scripts"),
        join(pluginDir, ".mcp.json"),
        claudeCodeSettingsPath(),
        logPath(),
      ];
    }
    case "codex": {
      const codexDir = process.env["MEMORY_CODEX_DIR"] ?? join(homedir(), ".codex");
      return [join(codexDir, "config.toml"), logPath()];
    }
    case "antigravity": {
      const antigravityDir =
        process.env["MEMORY_ANTIGRAVITY_DIR"] ??
        join(homedir(), ".gemini", "antigravity");
      return [
        join(antigravityDir, "mcp_config.json"),
        join(antigravityDir, "plugins", "memory"),
        logPath(),
      ];
    }
    case "claude-desktop":
      return [claudeDesktopConfigPath()];
    case "vscode":
      return [
        vscodeMcpConfigPath({ workspace: opts.workspace }),
        join(vscodeExtensionDir(opts.vscodeExtensionDir), "memory-fort.memory"),
        logPath(),
      ];
    default:
      return null;
  }
}

async function printVerify(opts: RunInstallOptions): Promise<void> {
  if (opts.noVerify) return;
  const result = await (opts.verifyFn ?? (() => runVerify()))();
  console.log("");
  console.log(formatVerifyResult(result).trimEnd());
}
