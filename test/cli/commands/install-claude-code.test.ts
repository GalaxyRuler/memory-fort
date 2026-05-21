import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { installClaudeCode } from "../../../src/cli/commands/install/claude-code.js";

describe("installClaudeCode", () => {
  let tmp: string;
  let memDir: string;
  let claudeDir: string;
  let repoDir: string;
  let origEnv: { mem?: string; repo?: string; claude?: string };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-"));
    memDir = join(tmp, ".memory");
    claudeDir = join(tmp, ".claude");
    repoDir = join(tmp, "repo");
    await mkdir(join(repoDir, "dist", "hooks"), { recursive: true });
    await writeFile(join(repoDir, "package.json"), "{}");
    for (const hook of [
      "session-start",
      "prompt-submit",
      "post-tool-use",
      "pre-compact",
      "session-end",
    ]) {
      await writeFile(join(repoDir, "dist", "hooks", `${hook}.mjs`), "// stub\n");
    }
    origEnv = {
      mem: process.env["MEMORY_ROOT"],
      repo: process.env["MEMORY_REPO_DIR"],
      claude: process.env["MEMORY_CLAUDE_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = repoDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origEnv.mem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origEnv.mem;
    if (origEnv.repo === undefined) delete process.env["MEMORY_REPO_DIR"];
    else process.env["MEMORY_REPO_DIR"] = origEnv.repo;
    if (origEnv.claude === undefined) delete process.env["MEMORY_CLAUDE_DIR"];
    else process.env["MEMORY_CLAUDE_DIR"] = origEnv.claude;
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates plugin manifest", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const manifest = JSON.parse(
      await readFile(
        join(memDir, "claude-code-plugin", ".claude-plugin", "plugin.json"),
        "utf-8",
      ),
    );
    expect(manifest.name).toBe("memory");
  });

  it("plugin manifest author is an object (Claude Code validation requirement)", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const manifest = JSON.parse(
      await readFile(
        join(memDir, "claude-code-plugin", ".claude-plugin", "plugin.json"),
        "utf-8",
      ),
    );
    expect(typeof manifest.author).toBe("object");
    expect(manifest.author).not.toBeNull();
    expect(manifest.author.name).toBe("GalaxyRuler");
  });

  it("writes hooks.json with all five hook events", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const hooks = JSON.parse(
      await readFile(
        join(memDir, "claude-code-plugin", "hooks", "hooks.json"),
        "utf-8",
      ),
    );
    expect(hooks.hooks.SessionStart).toBeDefined();
    expect(hooks.hooks.UserPromptSubmit).toBeDefined();
    expect(hooks.hooks.PostToolUse).toBeDefined();
    expect(hooks.hooks.PreCompact).toBeDefined();
    expect(hooks.hooks.Stop).toBeDefined();
  });

  it("hooks.json uses ${CLAUDE_PLUGIN_ROOT} prefix (not absolute paths)", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const hooks = JSON.parse(
      await readFile(
        join(memDir, "claude-code-plugin", "hooks", "hooks.json"),
        "utf-8",
      ),
    );
    const sessionStartCmd = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(sessionStartCmd).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(sessionStartCmd).not.toMatch(/[A-Z]:/);
    expect(sessionStartCmd).not.toMatch(/^\/[^$]/);
  });

  it("links plugin scripts dir to repo dist/hooks", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    expect(existsSync(join(memDir, "claude-code-plugin", "scripts"))).toBe(true);
    expect(
      existsSync(join(memDir, "claude-code-plugin", "scripts", "session-start.mjs")),
    ).toBe(true);
    expect((await lstat(join(memDir, "scripts"))).isSymbolicLink()).toBe(false);
  });

  it("creates .mcp.json INSIDE the plugin dir, NOT in claudeDir", async () => {
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.pluginMcpConfigPath).toBe(
      join(memDir, "claude-code-plugin", ".mcp.json"),
    );
    expect(existsSync(join(memDir, "claude-code-plugin", ".mcp.json"))).toBe(true);
    expect(existsSync(join(claudeDir, ".mcp.json"))).toBe(false);
    const mcp = JSON.parse(await readFile(result.pluginMcpConfigPath, "utf-8"));
    expect(mcp.mcpServers.memory).toBeDefined();
    expect(mcp.mcpServers.memory.command).toBe("node");
  });

  it("plugin .mcp.json uses ${CLAUDE_PLUGIN_ROOT} for the server path", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const content = JSON.parse(
      await readFile(join(memDir, "claude-code-plugin", ".mcp.json"), "utf-8"),
    );
    const args = content.mcpServers.memory.args as string[];
    expect(args.some((arg) => arg.includes("${CLAUDE_PLUGIN_ROOT}"))).toBe(true);
  });

  it("migrates legacy ~/.claude/.mcp.json by removing our entry and preserving others", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: { command: "node", args: ["old.mjs"] },
          other: { command: "node", args: ["keep.mjs"] },
        },
      }),
    );
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.legacyMigrated).toBe(true);
    const content = JSON.parse(await readFile(join(claudeDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers.memory).toBeUndefined();
    expect(content.mcpServers.other).toBeDefined();
  });

  it("deletes legacy ~/.claude/.mcp.json entirely if only our entry was there", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: { command: "node", args: ["old.mjs"] },
        },
      }),
    );
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.legacyMigrated).toBe(true);
    expect(existsSync(join(claudeDir, ".mcp.json"))).toBe(false);
  });

  it("no-ops migration when legacy .mcp.json does not exist", async () => {
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.legacyMigrated).toBe(false);
  });

  it("appends to log.md", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const log = await readFile(join(memDir, "log.md"), "utf-8");
    expect(log).toContain("install | claude-code");
  });

  it("is idempotent and reports already installed on second invocation", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.pluginMcpConfigPath).toBe(
      join(memDir, "claude-code-plugin", ".mcp.json"),
    );
    expect(existsSync(result.pluginMcpConfigPath)).toBe(true);
    expect(existsSync(join(claudeDir, ".mcp.json"))).toBe(false);
  });

  it("uses MEMORY_CLAUDE_DIR when claudeDir is not provided", async () => {
    process.env["MEMORY_CLAUDE_DIR"] = claudeDir;
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          memory: { command: "node", args: ["old.mjs"] },
        },
      }),
    );
    const result = await installClaudeCode({ repoDir });
    expect(result.legacyMigrated).toBe(true);
    expect(existsSync(join(claudeDir, ".mcp.json"))).toBe(false);
  });
});
