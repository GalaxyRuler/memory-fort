import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallClaudeDesktop } from "../../../src/cli/commands/install/claude-desktop.js";

describe("runInstallClaudeDesktop", () => {
  let tmp: string;
  let memDir: string;
  let claudeDesktopDir: string;
  let origMem: string | undefined;
  let origClaudeDesktop: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-claude-desktop-"));
    memDir = join(tmp, ".memory");
    claudeDesktopDir = join(tmp, "Claude");
    origMem = process.env["MEMORY_ROOT"];
    origClaudeDesktop = process.env["MEMORY_CLAUDE_DESKTOP_DIR"];
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = claudeDesktopDir;
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origClaudeDesktop === undefined) delete process.env["MEMORY_CLAUDE_DESKTOP_DIR"];
    else process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = origClaudeDesktop;
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes new config file when none exists", async () => {
    const result = await runInstallClaudeDesktop();
    expect(result.configCreated).toBe(true);
    expect(result.memoryEntryAction).toBe("created");
    expect(existsSync(result.configPath)).toBe(true);
    const content = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(content.mcpServers.memory.command).toBe("node");
    expect(content.mcpServers.memory.args[0]).toContain("mcp-server.mjs");
    expect(content.mcpServers.memory.args[0]).not.toContain("\\");
  });

  it("merges memory entry into existing mcpServers preserving other entries", async () => {
    await mkdir(claudeDesktopDir, { recursive: true });
    const configPath = join(claudeDesktopDir, "claude_desktop_config.json");
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    const result = await runInstallClaudeDesktop();
    expect(result.configCreated).toBe(false);
    expect(result.memoryEntryAction).toBe("created");
    expect(result.preservedServerCount).toBe(1);
    const content = JSON.parse(await readFile(configPath, "utf-8"));
    expect(content.mcpServers.other).toEqual({ command: "x" });
    expect(content.mcpServers.memory.command).toBe("node");
  });

  it("is idempotent when rerunning with same content", async () => {
    const first = await runInstallClaudeDesktop();
    const firstContent = await readFile(first.configPath, "utf-8");
    const second = await runInstallClaudeDesktop();
    const secondContent = await readFile(second.configPath, "utf-8");
    expect(second.configCreated).toBe(false);
    expect(second.memoryEntryAction).toBe("unchanged");
    expect(secondContent).toBe(firstContent);
  });

  it("repairs a corrupted memory entry and preserves other MCP servers", async () => {
    await mkdir(claudeDesktopDir, { recursive: true });
    const configPath = join(claudeDesktopDir, "claude_desktop_config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        theme: "dark",
        mcpServers: {
          other: { command: "other-server", args: ["--keep"] },
          memory: { command: 42, args: "not-an-array" },
        },
      }),
    );

    const result = await runInstallClaudeDesktop();

    expect(result.memoryEntryAction).toBe("updated");
    expect(result.log).toContain("repairing corrupted entry");
    expect(result.preservedServerCount).toBe(1);
    const content = JSON.parse(await readFile(configPath, "utf-8"));
    expect(content.theme).toBe("dark");
    expect(content.mcpServers.other).toEqual({ command: "other-server", args: ["--keep"] });
    expect(content.mcpServers.memory.command).toBe("node");
    expect(content.mcpServers.memory.args[0]).toContain("mcp-server.mjs");
  });

  it("throws clear error on malformed existing JSON", async () => {
    await mkdir(claudeDesktopDir, { recursive: true });
    const configPath = join(claudeDesktopDir, "claude_desktop_config.json");
    await writeFile(configPath, "{ not-json");
    await expect(runInstallClaudeDesktop()).rejects.toThrow(
      `failed to parse existing config at ${configPath}`,
    );
  });
});
