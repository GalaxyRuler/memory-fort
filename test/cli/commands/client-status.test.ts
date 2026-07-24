import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { formatClientStatus, getClientStatuses } from "../../../src/cli/commands/client-status.js";
import { getClientIntegrationStatuses } from "../../../src/clients/status.js";
import { runInstallOpenCode } from "../../../src/cli/commands/install/opencode.js";
import { chatgptBridgePidPath } from "../../../src/storage/paths.js";

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
      MEMORY_HERMES_DIR: process.env["MEMORY_HERMES_DIR"],
      MEMORY_OPENCODE_DIR: process.env["MEMORY_OPENCODE_DIR"],
      MEMORY_OPENCLAW_DIR: process.env["MEMORY_OPENCLAW_DIR"],
      MEMORY_OPENCOVEN_COMMAND: process.env["MEMORY_OPENCOVEN_COMMAND"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_CLAUDE_DIR"] = claudeDir;
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_HERMES_DIR"] = join(tmp, ".hermes");
    process.env["MEMORY_OPENCODE_DIR"] = join(tmp, ".config", "opencode");
    process.env["MEMORY_OPENCLAW_DIR"] = join(tmp, ".openclaw");
    process.env["MEMORY_OPENCOVEN_COMMAND"] = join(tmp, "missing-coven");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    await runInit({ sourceRepoDir: process.cwd() });
    await mkdir(join(memDir, "claude-code-plugin", ".claude-plugin"), {
      recursive: true,
    });
    await mkdir(join(memDir, "hooks"), { recursive: true });
    await mkdir(join(memDir, "claude-code-plugin", "scripts"), { recursive: true });
    await writeFile(
      join(memDir, "claude-code-plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "memory" }),
    );
    await writeFile(
      join(memDir, "claude-code-plugin", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: {
            command: "node",
            args: [join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs")],
          },
        },
      }),
    );
    await writeFile(
      join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs"),
      "// stub\n",
    );
    await writeFile(join(memDir, "hooks", "mcp-server.mjs"), "// mcp stub\n");
    await writeFile(join(memDir, "hooks", "opencode-event.mjs"), "// event stub\n");
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

  it("uses the bounded MCP probe from the production CLI status path", async () => {
    const codexDir = process.env["MEMORY_CODEX_DIR"]!;
    const mcpServer = join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), [
      "[mcp_servers.memory]",
      'command = "node"',
      `args = [${JSON.stringify(mcpServer.replace(/\\/g, "/"))}]`,
      "",
    ].join("\n"));
    const probeMcpCommand = vi.fn(async () => "healthy" as const);

    const statuses = await getClientStatuses({ probeMcpCommand });

    expect(statuses.find((item) => item.client === "codex")?.state).toBe("installed");
    expect(probeMcpCommand).toHaveBeenCalledWith({
      command: "node",
      args: [join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs")],
    });
  });

  it("reports bounded MCP failures as Unhealthy in the CLI rather than a healthy installed status", async () => {
    const codexDir = process.env["MEMORY_CODEX_DIR"]!;
    const mcpServer = join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs");
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), [
      "[mcp_servers.memory]",
      'command = "node"',
      `args = [${JSON.stringify(mcpServer.replace(/\\/g, "/"))}]`,
      "",
    ].join("\n"));

    const status = (await getClientStatuses({
      probeMcpCommand: async () => "unhealthy",
    })).find((item) => item.client === "codex")!;

    expect(status.detail).toContain("bounded MCP initialize + tools/list probe failed");
    expect(formatClientStatus(status)).toContain("Health: Unhealthy");
    expect(formatClientStatus(status)).not.toMatch(/^✓/);
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
    await runInstallOpenCode({ opencodeDir });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("installed");
    expect(status.detail).toContain("installed");
  });

  it("reports OpenCode stale when only part of the install exists", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir);

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the referenced MCP hook target is missing", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await rm(join(memDir, "hooks", "mcp-server.mjs"), { force: true });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the referenced MCP hook target is a directory", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await rm(join(memDir, "hooks", "mcp-server.mjs"), { force: true });
    await mkdir(join(memDir, "hooks", "mcp-server.mjs"));

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the referenced event hook target is missing", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await rm(join(memDir, "hooks", "opencode-event.mjs"), { force: true });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the referenced event hook target is a directory", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await rm(join(memDir, "hooks", "opencode-event.mjs"), { force: true });
    await mkdir(join(memDir, "hooks", "opencode-event.mjs"));

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP entry is disabled", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir, { enabled: false });
    await writeOpenCodePlugin(opencodeDir);

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command targets the wrong file", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: ["node", join(opencodeDir, "hooks", "other-server.mjs")],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP entry has extra keys", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      extraMemoryKeys: {
        cwd: tmp,
        env: { MEMORY_ROOT: memDir },
      },
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command uses an absolute node executable", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: ["C:/tmp/node.exe", join(memDir, "hooks", "mcp-server.mjs")],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command is reversed", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: [join(memDir, "hooks", "mcp-server.mjs"), "node"],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when a wrong script precedes the server path", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: [
        "node",
        join(memDir, "hooks", "wrong-server.mjs"),
        join(memDir, "hooks", "mcp-server.mjs"),
      ],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command has extra args after the server path", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: ["node", join(memDir, "hooks", "mcp-server.mjs"), "--stale-extra"],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command targets another root", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: ["node", join(tmp, "other-root", "hooks", "mcp-server.mjs")],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the MCP command includes non-string entries", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await runInstallOpenCode({ opencodeDir });
    await writeOpenCodeConfig(opencodeDir, {
      command: ["node", join(memDir, "hooks", "mcp-server.mjs"), 42],
    });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the plugin content is wrong", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir);
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(join(opencodeDir, "plugins", "memory-fort.js"), "// unrelated plugin\n");

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when plugin text has loose markers but no hooks", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir);
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(
      join(opencodeDir, "plugins", "memory-fort.js"),
      "export const MemoryFortOpenCode = async () => import('file:///tmp/opencode-event.mjs');\n",
    );

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when the plugin path is a directory", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir);
    await mkdir(join(opencodeDir, "plugins", "memory-fort.js"), { recursive: true });

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when all plugin markers are only comments", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await writeOpenCodeConfig(opencodeDir);
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(
      join(opencodeDir, "plugins", "memory-fort.js"),
      commentOnlyOpenCodePlugin(),
    );

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode stale when opencode.json is malformed", async () => {
    const opencodeDir = process.env["MEMORY_OPENCODE_DIR"]!;
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(join(opencodeDir, "opencode.json"), "{");
    await writeOpenCodePlugin(opencodeDir);

    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("stale");
    expect(status.detail).toBe("installed but memory MCP or plugin file is missing or stale");
  });

  it("reports OpenCode missing when neither config nor plugin exists", async () => {
    const statuses = await getClientStatuses();

    const status = statuses.find((item) => item.client === "opencode")!;
    expect(status.state).toBe("missing");
    expect(status.detail).toBe("not installed");
  });

  it("marks a configured Codex integration stale when its referenced executable is missing", async () => {
    const codexDir = process.env["MEMORY_CODEX_DIR"]!;
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), [
      "[mcp_servers.memory]",
      'command = "node"',
      'args = ["mcp-server.mjs"]',
      "",
    ].join("\n"));
    await rm(join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs"));

    const status = (await getClientIntegrationStatuses()).find((item) => item.client === "codex")!;
    expect(status.installation).toBe("stale");
    expect(status.evidence[0]).toContain("executable is missing");
  });

  it("does not treat a ChatGPT PID file as health evidence", async () => {
    const configPath = join(memDir, "config.yaml");
    await writeFile(configPath, "clients:\n  chatgpt: true\n");
    await writeFile(chatgptBridgePidPath(), String(process.pid));

    const status = (await getClientIntegrationStatuses({
      now: () => new Date("2026-07-24T00:00:00.000Z"),
      probeChatGpt: async () => "unhealthy",
    })).find((item) => item.client === "chatgpt")!;
    expect(status.installation).toBe("installed");
    expect(status.health).toBe("unhealthy");
    expect(status.evidence[0]).toContain("PID files are not health evidence");
  });

  it("probes Hermes and OpenClaw with their configured vault MCP launcher", async () => {
    const mcpServer = join(memDir, "hooks", "mcp-server.mjs");
    await writeHermesConfig(mcpServer);
    await writeOpenClawConfig(mcpServer);
    const probeMcpCommand = vi.fn(async (command: { command: string; args: string[] }) => (
      command.command === "node" && command.args[0] === mcpServer ? "healthy" as const : "unhealthy" as const
    ));

    const statuses = await getClientIntegrationStatuses({ probeMcp: true, probeMcpCommand });

    for (const client of ["hermes", "openclaw"] as const) {
      const status = statuses.find((item) => item.client === client)!;
      expect(status.installation).toBe("installed");
      expect(status.health).toBe("healthy");
    }
    expect(probeMcpCommand).toHaveBeenCalledTimes(2);
    expect(probeMcpCommand).toHaveBeenCalledWith({ command: "node", args: [mcpServer] });
  });

  it("marks wrong or missing Hermes and OpenClaw launchers stale despite an unrelated Claude launcher", async () => {
    const hookMcpServer = join(memDir, "hooks", "mcp-server.mjs");
    const claudeMcpServer = join(memDir, "claude-code-plugin", "scripts", "mcp-server.mjs");
    await writeHermesConfig(claudeMcpServer);
    await writeOpenClawConfig(claudeMcpServer);
    const probeMcpCommand = vi.fn(async () => "healthy" as const);

    let statuses = await getClientIntegrationStatuses({ probeMcp: true, probeMcpCommand });
    for (const client of ["hermes", "openclaw"] as const) {
      const status = statuses.find((item) => item.client === client)!;
      expect(status.installation).toBe("stale");
      expect(status.health).toBe("unknown");
    }
    expect(probeMcpCommand).not.toHaveBeenCalled();

    await writeOpenClawConfig(hookMcpServer);
    await rm(hookMcpServer, { force: true });
    statuses = await getClientIntegrationStatuses({ probeMcp: true, probeMcpCommand });
    const missingOpenClaw = statuses.find((item) => item.client === "openclaw")!;
    expect(missingOpenClaw.installation).toBe("stale");
    expect(missingOpenClaw.health).toBe("unknown");
    expect(probeMcpCommand).not.toHaveBeenCalled();
  });

  async function writeOpenCodeConfig(
    opencodeDir: string,
    overrides: Partial<{
      command: unknown;
      enabled: boolean;
      extraMemoryKeys: Record<string, unknown>;
    }> = {},
  ): Promise<void> {
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          memory: {
            type: "local",
            command: overrides.command ?? ["node", join(memDir, "hooks", "mcp-server.mjs")],
            enabled: overrides.enabled ?? true,
            ...overrides.extraMemoryKeys,
          },
        },
      }),
    );
  }

  async function writeHermesConfig(mcpServer: string): Promise<void> {
    const hermesDir = process.env["MEMORY_HERMES_DIR"]!;
    await mkdir(hermesDir, { recursive: true });
    await writeFile(join(hermesDir, "config.yaml"), [
      "# === BEGIN memory-system v0.1.0 ===",
      "hooks:",
      `  on_session_start: ${JSON.stringify(`node ${join(memDir, "hooks", "session-start.mjs").replace(/\\/g, "/")}`)}`,
      "mcp_servers:",
      "  memory:",
      "    command: node",
      `    args: [${JSON.stringify(mcpServer.replace(/\\/g, "/"))}]`,
      "# === END memory-system v0.1.0 ===",
      "",
    ].join("\n"));
  }

  async function writeOpenClawConfig(mcpServer: string): Promise<void> {
    const openclawDir = process.env["MEMORY_OPENCLAW_DIR"]!;
    await mkdir(openclawDir, { recursive: true });
    await writeFile(join(openclawDir, "openclaw.json"), JSON.stringify({
      mcpServers: { memory: { command: "node", args: [mcpServer] } },
    }));
  }

  async function writeOpenCodePlugin(opencodeDir: string): Promise<void> {
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(
      join(opencodeDir, "plugins", "memory-fort.js"),
      "export const MemoryFortOpenCode = async () => import('file:///tmp/opencode-event.mjs');\n",
    );
  }

  function commentOnlyOpenCodePlugin(): string {
    const eventHook = `${memDir.replace(/\\/g, "/")}/hooks/opencode-event.mjs`;
    return [
      "// Generated by memory-fort.",
      "// export const MemoryFortOpenCode",
      `// ${eventHook}`,
      "// event: async ({ event })",
      '// "tool.execute.after": async (input, output) =>',
      "// .stdin(JSON.stringify(event))",
      "export default {};",
      "",
    ].join("\n");
  }
});
