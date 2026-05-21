import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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

  it("links scripts dir to repo dist/hooks", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    expect(existsSync(join(memDir, "scripts"))).toBe(true);
    expect(existsSync(join(memDir, "scripts", "session-start.mjs"))).toBe(true);
  });

  it("creates .mcp.json with memory server entry", async () => {
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.mcpConfigCreated).toBe(true);
    const mcp = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(mcp.mcpServers.memory).toBeDefined();
    expect(mcp.mcpServers.memory.command).toBe("node");
  });

  it("merges into existing .mcp.json without destroying entries", async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      join(claudeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { other: { command: "node", args: ["other.mjs"] } },
      }),
    );
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.mcpConfigCreated).toBe(false);
    const mcp = JSON.parse(await readFile(result.mcpConfigPath, "utf-8"));
    expect(mcp.mcpServers.other).toBeDefined();
    expect(mcp.mcpServers.memory).toBeDefined();
  });

  it("appends to log.md", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const log = await readFile(join(memDir, "log.md"), "utf-8");
    expect(log).toContain("install | claude-code");
  });

  it("is idempotent and reports already installed on second invocation", async () => {
    await installClaudeCode({ repoDir, claudeDir });
    const result = await installClaudeCode({ repoDir, claudeDir });
    expect(result.alreadyInstalled).toBe(true);
    expect(result.log.some((line) => line.includes("already installed"))).toBe(true);
  });

  it("uses MEMORY_CLAUDE_DIR when claudeDir is not provided", async () => {
    process.env["MEMORY_CLAUDE_DIR"] = claudeDir;
    const result = await installClaudeCode({ repoDir });
    expect(result.mcpConfigPath).toBe(join(claudeDir, ".mcp.json"));
    expect(existsSync(result.mcpConfigPath)).toBe(true);
  });
});
