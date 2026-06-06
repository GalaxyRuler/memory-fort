import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runUninstall } from "../../../src/cli/commands/uninstall.js";
import { installAntigravity } from "../../../src/cli/commands/install/antigravity.js";
import { installClaudeCode } from "../../../src/cli/commands/install/claude-code.js";
import { runInstallClaudeDesktop } from "../../../src/cli/commands/install/claude-desktop.js";
import { installCodex } from "../../../src/cli/commands/install/codex.js";
import { installVsCode } from "../../../src/cli/commands/install/vscode.js";

describe("runUninstall", () => {
  let tmp: string;
  let memDir: string;
  let repoDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "uninstall-"));
    memDir = join(tmp, ".memory");
    repoDir = join(tmp, "repo");
    await mkdir(join(repoDir, "dist", "hooks"), { recursive: true });
    await writeFile(join(repoDir, "package.json"), "{}");
    for (const hook of [
      "session-start",
      "prompt-submit",
      "post-tool-use",
      "pre-compact",
      "session-end",
      "mcp-server",
    ]) {
      await writeFile(join(repoDir, "dist", "hooks", `${hook}.mjs`), "// stub\n");
    }
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_REPO_DIR: process.env["MEMORY_REPO_DIR"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_HERMES_DIR: process.env["MEMORY_HERMES_DIR"],
      MEMORY_PI_DIR: process.env["MEMORY_PI_DIR"],
      MEMORY_OPENCLAW_DIR: process.env["MEMORY_OPENCLAW_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
      MEMORY_VSCODE_EXTENSION_DIR: process.env["MEMORY_VSCODE_EXTENSION_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = repoDir;
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_HERMES_DIR"] = join(tmp, ".hermes");
    process.env["MEMORY_PI_DIR"] = join(tmp, ".pi");
    process.env["MEMORY_OPENCLAW_DIR"] = join(tmp, ".openclaw");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    process.env["MEMORY_VSCODE_EXTENSION_DIR"] = join(tmp, "extensions");
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("removes only the Codex sentinel block and restores existing config bytes", async () => {
    const codexConfig = join(process.env["MEMORY_CODEX_DIR"]!, "config.toml");
    const before = "[model]\nname = \"gpt-5\"\n# user comment\n";
    await mkdir(join(tmp, ".codex"), { recursive: true });
    await writeFile(codexConfig, before);
    await installCodex();

    const result = await runUninstall("codex");

    expect(result.exitCode).toBe(0);
    await expect(readFile(codexConfig, "utf-8")).resolves.toBe(before);
  });

  it("restores Codex config without adding a trailing newline", async () => {
    const codexConfig = join(process.env["MEMORY_CODEX_DIR"]!, "config.toml");
    const before = "[model]\nname = \"gpt-5\"\n# user comment";
    await mkdir(join(tmp, ".codex"), { recursive: true });
    await writeFile(codexConfig, before);
    await installCodex();

    const result = await runUninstall("codex");

    expect(result.exitCode).toBe(0);
    await expect(readFile(codexConfig, "utf-8")).resolves.toBe(before);
  });

  it("uninstalling Codex when absent is a clean no-op", async () => {
    const result = await runUninstall("codex");

    expect(result.exitCode).toBe(0);
    expect(result.actions.some((action) => action.includes("not installed"))).toBe(true);
  });

  it("dry-runs Codex uninstall without modifying config", async () => {
    const codexConfig = join(process.env["MEMORY_CODEX_DIR"]!, "config.toml");
    await installCodex();
    const before = await readFile(codexConfig, "utf-8");

    const result = await runUninstall("codex", { dryRun: true });

    expect(result.dryRun).toBe(true);
    await expect(readFile(codexConfig, "utf-8")).resolves.toBe(before);
  });

  it("removes Claude Desktop memory MCP entry and preserves other servers", async () => {
    const configPath = join(process.env["MEMORY_CLAUDE_DESKTOP_DIR"]!, "claude_desktop_config.json");
    const before = `${JSON.stringify({ mcpServers: { other: { command: "node", args: ["other.mjs"] } }, theme: "dark" }, null, 2)}\n`;
    await mkdir(process.env["MEMORY_CLAUDE_DESKTOP_DIR"]!, { recursive: true });
    await writeFile(configPath, before);
    await runInstallClaudeDesktop();

    await runUninstall("claude-desktop");

    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
  });

  it("removes Antigravity memory entry and live plugin only", async () => {
    const antigravityDir = process.env["MEMORY_ANTIGRAVITY_DIR"]!;
    const configPath = join(antigravityDir, "mcp_config.json");
    const before = `${JSON.stringify({ mcpServers: { other: { command: "node", args: ["other.mjs"] } }, ui: { theme: "dark" } }, null, 2)}\n`;
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(configPath, before);
    const install = await installAntigravity({ antigravityVersion: "2.1.0" });
    expect(existsSync(install.pluginDir)).toBe(true);

    await runUninstall("antigravity");

    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
    expect(existsSync(install.pluginDir)).toBe(false);
  });

  it("removes VS Code memory server and bundled extension only", async () => {
    const configPath = join(process.env["MEMORY_VSCODE_USER_DIR"]!, "mcp.json");
    const before = `${JSON.stringify({ servers: { other: { type: "stdio", command: "node", args: ["other.mjs"] } }, inputs: [{ id: "token" }] }, null, 2)}\n`;
    await mkdir(process.env["MEMORY_VSCODE_USER_DIR"]!, { recursive: true });
    await writeFile(configPath, before);
    const install = await installVsCode({ installed: true });
    expect(existsSync(install.extensionPath!)).toBe(true);

    await runUninstall("vscode");

    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
    expect(existsSync(install.extensionPath!)).toBe(false);
  });

  it("removes Claude Code plugin files and settings keys while preserving user settings", async () => {
    const claudeDir = process.env["MEMORY_CLAUDE_DIR"]!;
    const settingsPath = join(claudeDir, "settings.json");
    const before = `${JSON.stringify({
      theme: "dark",
      enabledPlugins: { "formatter@team-tools": true },
      extraKnownMarketplaces: { "team-tools": { source: { source: "github", repo: "team/tools" } } },
    }, null, 2)}\n`;
    await mkdir(claudeDir, { recursive: true });
    await writeFile(settingsPath, before);
    const install = await installClaudeCode({ claudePluginCli: false });
    expect(existsSync(install.pluginDir)).toBe(true);

    await runUninstall("claude-code");

    await expect(readFile(settingsPath, "utf-8")).resolves.toBe(before);
    expect(existsSync(join(memDir, "claude-code-plugin"))).toBe(false);
    expect(existsSync(join(memDir, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  it("uninstalls Claude Code plugin cache before removing plugin files", async () => {
    const calls: string[][] = [];
    const execFileFn = async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    const install = await installClaudeCode({
      claudePluginCli: true,
      execFileFn: execFileFn as never,
    });
    expect(existsSync(install.pluginDir)).toBe(true);
    const installCallCount = calls.length;

    const result = await runUninstall("claude-code", {
      claudePluginCli: true,
      execFileFn: execFileFn as never,
    });

    expect(result.exitCode).toBe(0);
    expect(calls.slice(installCallCount)).toEqual([
      ["plugin", "uninstall", "memory@memory-local"],
      ["plugin", "marketplace", "remove", "memory-local"],
    ]);
    expect(existsSync(join(memDir, "claude-code-plugin"))).toBe(false);
    expect(existsSync(join(memDir, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  it("continues Claude Code uninstall when claude CLI is absent", async () => {
    const install = await installClaudeCode({ claudePluginCli: false });
    expect(existsSync(install.pluginDir)).toBe(true);
    const execFileFn = async () => {
      const err = new Error("claude not found") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };

    const result = await runUninstall("claude-code", {
      claudePluginCli: true,
      execFileFn: execFileFn as never,
    });

    expect(result.exitCode).toBe(0);
    expect(result.actions.some((action) => action.includes("claude CLI not found"))).toBe(true);
    expect(existsSync(join(memDir, "claude-code-plugin"))).toBe(false);
    expect(existsSync(join(memDir, ".claude-plugin", "marketplace.json"))).toBe(false);
  });

  it("dry-runs Claude Code uninstall without deleting plugin files", async () => {
    const install = await installClaudeCode({ claudePluginCli: false });

    const result = await runUninstall("claude-code", { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(existsSync(install.pluginDir)).toBe(true);
    await expect(lstat(join(memDir, ".claude-plugin", "marketplace.json"))).resolves.toBeDefined();
  });
});
