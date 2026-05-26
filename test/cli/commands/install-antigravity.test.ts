import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { installAntigravity } from "../../../src/cli/commands/install/antigravity.js";

describe("installAntigravity", () => {
  let tmp: string;
  let memDir: string;
  let antigravityDir: string;
  let origMem: string | undefined;
  let origAntigravity: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "instag-"));
    memDir = join(tmp, ".memory");
    antigravityDir = join(tmp, ".gemini", "antigravity");
    origMem = process.env["MEMORY_ROOT"];
    origAntigravity = process.env["MEMORY_ANTIGRAVITY_DIR"];
    process.env["MEMORY_ROOT"] = memDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origAntigravity === undefined) delete process.env["MEMORY_ANTIGRAVITY_DIR"];
    else process.env["MEMORY_ANTIGRAVITY_DIR"] = origAntigravity;
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates mcp_config.json at the canonical path when absent", async () => {
    const result = await installAntigravity({ antigravityDir });
    expect(result.configCreated).toBe(true);
    expect(existsSync(result.mcpConfigPath)).toBe(true);
    const content = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(content.mcpServers.memory).toBeDefined();
    expect(content.mcpServers.memory.command).toBe("node");
    expect(content.mcpServers.memory.args[0]).toContain("mcp-server.mjs");
  });

  it("preserves other mcpServers entries when merging", async () => {
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(
      join(antigravityDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "node", args: ["other.mjs"] },
        },
      }),
    );
    const result = await installAntigravity({ antigravityDir });
    expect(result.configCreated).toBe(false);
    const content = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(content.mcpServers.other).toBeDefined();
    expect(content.mcpServers.memory).toBeDefined();
  });

  it("updates existing memory entry on re-install", async () => {
    await installAntigravity({ antigravityDir });
    const result = await installAntigravity({ antigravityDir });
    expect(result.hadPriorMemoryEntry).toBe(true);
    const content = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(content.mcpServers.memory).toBeDefined();
  });

  it("preserves other top-level keys not in mcpServers", async () => {
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(
      join(antigravityDir, "mcp_config.json"),
      JSON.stringify({
        someOtherTopKey: { foo: "bar" },
        mcpServers: { x: { command: "y" } },
      }),
    );
    await installAntigravity({ antigravityDir });
    const content = JSON.parse(
      await readFile(join(antigravityDir, "mcp_config.json"), "utf-8"),
    );
    expect(content.someOtherTopKey).toEqual({ foo: "bar" });
    expect(content.mcpServers.x).toBeDefined();
    expect(content.mcpServers.memory).toBeDefined();
  });

  it("treats empty existing mcp_config.json as new install", async () => {
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(join(antigravityDir, "mcp_config.json"), "");
    const result = await installAntigravity({ antigravityDir });
    expect(result.configCreated).toBe(true);
    const content = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(content.mcpServers.memory).toBeDefined();
  });

  it("handles malformed JSON gracefully", async () => {
    await mkdir(antigravityDir, { recursive: true });
    await writeFile(join(antigravityDir, "mcp_config.json"), "not json {");
    await installAntigravity({ antigravityDir });
    const content = JSON.parse(
      await readFile(join(antigravityDir, "mcp_config.json"), "utf-8"),
    );
    expect(content.mcpServers.memory).toBeDefined();
  });

  it("appends to log.md", async () => {
    await installAntigravity({ antigravityDir });
    const log = await readFile(join(memDir, "log.md"), "utf-8");
    expect(log).toContain("install | antigravity");
  });

  it("mcp-server path uses absolute path and not ${CLAUDE_PLUGIN_ROOT}", async () => {
    const result = await installAntigravity({ antigravityDir });
    const content = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    const arg = content.mcpServers.memory.args[0];
    expect(arg).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(arg).toMatch(/[A-Za-z]:.*claude-code-plugin\/scripts\/mcp-server\.mjs$/);
  });

  it("uses MEMORY_ANTIGRAVITY_DIR when antigravityDir is not provided", async () => {
    process.env["MEMORY_ANTIGRAVITY_DIR"] = antigravityDir;
    const result = await installAntigravity();
    expect(result.mcpConfigPath).toBe(join(antigravityDir, "mcp_config.json"));
    expect(existsSync(result.mcpConfigPath)).toBe(true);
  });

  it("treats workspace and IDE as the same shared Antigravity MCP surface", async () => {
    const result = await installAntigravity({
      antigravityDir,
      surface: "both",
      antigravityVersion: "2.0.0",
    });
    expect(result.surfaces).toEqual(["workspace", "ide"]);
    expect(result.mcpConfigPath).toBe(join(antigravityDir, "mcp_config.json"));
  });

  it("installs the Antigravity 2.0 live-capture plugin with all hook handlers", async () => {
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });

    expect(result.livePluginInstalled).toBe(true);
    expect(result.pluginDir).toBe(join(antigravityDir, "plugins", "memory"));

    const manifest = JSON.parse(
      await readFile(join(result.pluginDir, "plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe("memory");
    expect(manifest.hooks).toBe("./hooks.json");

    const hooks = JSON.parse(await readFile(join(result.pluginDir, "hooks.json"), "utf-8"));
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "context_compaction",
      "post_tool_call",
      "post_turn",
      "pre_tool_call",
      "pre_turn",
      "session_end",
      "session_start",
      "tool_error_recovery",
      "user_interaction_handling",
    ]);

    for (const hookName of Object.keys(hooks.hooks)) {
      const command = hooks.hooks[hookName][0].command as string;
      expect(command).toContain(`hooks/${hookName}.mjs`);
      expect(existsSync(join(result.pluginDir, "hooks", `${hookName}.mjs`))).toBe(true);
    }
  });

  it("skips live-capture plugin install gracefully when Antigravity is older than 2.0", async () => {
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "1.23.2",
    });

    expect(result.livePluginInstalled).toBe(false);
    expect(result.pluginDir).toBe(join(antigravityDir, "plugins", "memory"));
    expect(existsSync(result.mcpConfigPath)).toBe(true);
    expect(existsSync(result.pluginDir)).toBe(false);
    expect(result.log.join("\n")).toContain("Antigravity 2.0 required for live capture");
  });
});
