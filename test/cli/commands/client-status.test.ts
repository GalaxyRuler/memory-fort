import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { getClientStatuses } from "../../../src/cli/commands/client-status.js";

describe("getClientStatuses", () => {
  let tmp: string;
  let memDir: string;
  let claudeDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "client-status-"));
    memDir = join(tmp, ".memory");
    claudeDir = join(tmp, ".claude");
    origEnv = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_OPENCODE_DIR: process.env["MEMORY_OPENCODE_DIR"],
      MEMORY_OPENCOVEN_COMMAND: process.env["MEMORY_OPENCOVEN_COMMAND"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_CLAUDE_DIR"] = claudeDir;
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_OPENCODE_DIR"] = join(tmp, ".config", "opencode");
    process.env["MEMORY_OPENCOVEN_COMMAND"] = join(tmp, "missing-coven");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    await runInit({ sourceRepoDir: process.cwd() });
    await mkdir(join(memDir, "claude-code-plugin", ".claude-plugin"), {
      recursive: true,
    });
    await mkdir(join(memDir, "claude-code-plugin", "scripts"), { recursive: true });
    await writeFile(
      join(memDir, "claude-code-plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "memory" }),
    );
    await writeFile(
      join(memDir, "claude-code-plugin", ".mcp.json"),
      JSON.stringify({ mcpServers: { memory: {} } }),
    );
    await writeFile(
      join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs"),
      "// stub\n",
    );
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("warns when the Claude Code plugin files exist but the plugin is not enabled", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: {} }),
    );

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "claude-code")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toContain("plugin installed but not enabled");
  });

  it("reports Claude Code installed when the plugin files exist and the plugin is enabled", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "memory@memory-local": true } }),
    );

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "claude-code")!;
    expect(status.state).toBe("installed");
    expect(status.detail).toContain("installed and enabled");
  });

  it("reports OpenCoven as missing when the coven CLI is unavailable", async () => {
    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencoven")!;
    expect(status.state).toBe("missing");
    expect(status.detail).toContain("coven CLI not found");
    expect(status.configPath).toContain("coven.sock");
  });

  it("reports OpenCode installed when its MCP config and plugin exist", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.json"),
      JSON.stringify({ mcp: { memory: { type: "local", command: ["node", "mcp-server.mjs"] } } }),
    );
    await writeFile(join(opencodeDir, "plugins", "memory-fort.js"), "// plugin\n");

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("installed");
    expect(status.detail).toBe("installed");
  });

  it("reports OpenCode stale when only part of the install exists", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.json"),
      JSON.stringify({ mcp: { memory: { type: "local", command: ["node", "mcp-server.mjs"] } } }),
    );

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing");
  });

  it("reports OpenCode missing when neither config nor plugin exists", async () => {
    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("missing");
    expect(status.detail).toBe("not installed");
  });
});
