import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { installAntigravity } from "../../../src/cli/commands/install/antigravity.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";
import { beginIndexInvalidation } from "../../../src/index/generation.js";
import { seedBuiltHooks } from "./install/seed-built-hooks.js";

describe("installAntigravity", () => {
  let tmp: string;
  let memDir: string;
  let antigravityDir: string;
  let origMem: string | undefined;
  let origAntigravity: string | undefined;
  let origRepo: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "instag-"));
    memDir = join(tmp, ".memory");
    antigravityDir = join(tmp, ".gemini", "antigravity");
    const repoDir = join(tmp, "repo");
    await seedBuiltHooks(repoDir);
    origMem = process.env["MEMORY_ROOT"];
    origAntigravity = process.env["MEMORY_ANTIGRAVITY_DIR"];
    origRepo = process.env["MEMORY_REPO_DIR"];
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = repoDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origAntigravity === undefined) delete process.env["MEMORY_ANTIGRAVITY_DIR"];
    else process.env["MEMORY_ANTIGRAVITY_DIR"] = origAntigravity;
    if (origRepo === undefined) delete process.env["MEMORY_REPO_DIR"];
    else process.env["MEMORY_REPO_DIR"] = origRepo;
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
    expect(isAbsolute(arg)).toBe(true);
    expect(arg).toContain("mcp-server.mjs");
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

  it("installs the live-capture plugin when Antigravity version detection is unavailable", async () => {
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: null,
    });

    expect(result.livePluginInstalled).toBe(true);
    expect(result.pluginDir).toBe(join(antigravityDir, "plugins", "memory"));
    expect(existsSync(join(result.pluginDir, "plugin.json"))).toBe(true);
    expect(result.log.join("\n")).toContain(
      "version not detected; installed Antigravity live-capture plugin",
    );
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

  it("writes parseable YAML frontmatter for Windows cwd paths", async () => {
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "pre_turn.mjs");
    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "win-cwd",
        timestamp: "2026-06-01T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
        prompt: "capture this",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });
    expect(hook.status).toBe(0);

    const raw = await readFile(
      join(memDir, "raw", "2026-06-01", "antigravity-win-cwd.md"),
      "utf-8",
    );
    expect(parseFrontmatter(raw).frontmatter.cwd).toBe("C:\\Repos\\memory-system");
  });

  it("session_start hook emits cwd-aware project memory while preserving live capture", async () => {
    await writeAntigravityProjectMemoryFixture(memDir);
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system\\.claude\\worktrees\\x",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("--- Current project memory");
    expect(hook.stdout).toContain("Memory-system Antigravity body should be emitted.");
    expect(hook.stdout).toContain("- AgentMemory (wiki/projects/agentmemory.md): AgentMemory summary from index.");
    expect(hook.stdout.indexOf("--- Current project memory")).toBeLessThan(
      hook.stdout.indexOf("--- Index"),
    );
    const raw = await readFile(
      join(memDir, "raw", "2026-06-02", "antigravity-project-memory.md"),
      "utf-8",
    );
    expect(raw).toContain("## [00:00:00] Session Start");
  });

  it("session_start hook suppresses index and current-project context while the generation is invalidating", async () => {
    await writeAntigravityProjectMemoryFixture(memDir);
    await writeFile(
      join(memDir, "wiki", "preferences.md"),
      "---\ntitle: Operator Preferences\n---\n\nANTIGRAVITY-STALE-REMINDER\n",
    );
    await rm(join(memDir, "wiki", "projects", "agentmemory.md"));
    await writeFile(
      join(memDir, "index.md"),
      "- [AgentMemory](wiki/projects/agentmemory.md) - STALE-FORGOTTEN-SUMMARY\n",
    );
    await beginIndexInvalidation(memDir);
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory-invalidating",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("--- Schema");
    expect(hook.stdout).not.toContain("--- Current project memory");
    expect(hook.stdout).not.toContain("--- Related memory");
    expect(hook.stdout).not.toContain("--- Index");
    expect(hook.stdout).not.toContain("STALE-FORGOTTEN-SUMMARY");
    expect(hook.stdout).not.toContain("--- What you should remember ---");
    expect(hook.stdout).not.toContain("ANTIGRAVITY-STALE-REMINDER");
    expect(existsSync(join(memDir, "raw", "2026-06-02", "antigravity-project-memory-invalidating.md"))).toBe(true);
  });

  it("session_start hook emits live wiki preferences only while the generation remains ready", async () => {
    await writeAntigravityProjectMemoryFixture(memDir);
    await writeFile(
      join(memDir, "wiki", "preferences.md"),
      "---\ntitle: Operator Preferences\nupdated: 2026-06-02\n---\n\nANTIGRAVITY-LIVE-REMINDER\n",
    );
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const ready = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "preference-ready",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });
    expect(ready.status).toBe(0);
    expect(ready.stdout).toContain("--- What you should remember ---");
    expect(ready.stdout).toContain("ANTIGRAVITY-LIVE-REMINDER");

    await beginIndexInvalidation(memDir);
    const invalidating = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "preference-invalidating",
        timestamp: "2026-06-02T00:00:01.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });
    expect(invalidating.status).toBe(0);
    expect(invalidating.stdout).not.toContain("--- What you should remember ---");
    expect(invalidating.stdout).not.toContain("ANTIGRAVITY-LIVE-REMINDER");
  });

  it("session_start hook drops missing relation targets and stale generated-index lines", async () => {
    await writeAntigravityProjectMemoryFixture(memDir);
    await rm(join(memDir, "wiki", "projects", "agentmemory.md"));
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory-missing-target",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("--- Current project memory");
    expect(hook.stdout).toContain("--- Related memory ---\n(none found)");
    expect(hook.stdout).not.toContain("AgentMemory summary from index.");
    const indexBlock = hook.stdout.slice(
      hook.stdout.indexOf("--- Index"),
      hook.stdout.indexOf("--- Recent log"),
    );
    expect(indexBlock).not.toContain("wiki/projects/agentmemory.md");
  });

  it("session_start hook excludes retained paths from project, related, and index context", async () => {
    await writeAntigravityProjectMemoryFixture(
      memDir,
      "Project body references [[raw/.compact-archive/2026-06-02/retained.md]].",
    );
    const projectPath = join(memDir, "wiki", "projects", "memory-system.md");
    const project = await readFile(projectPath, "utf-8");
    await writeFile(
      projectPath,
      project.replace(
        "    - wiki/projects/agentmemory.md",
        [
          "    - wiki/projects/agentmemory.md",
          "    - wiki/archive/retained-from-relation.md",
          "    - wiki/_archive/retained-from-maintenance.md",
        ].join("\n"),
      ),
    );
    await writeFile(
      join(memDir, "index.md"),
      [
        "- [AgentMemory](wiki/projects/agentmemory.md) - Live summary.",
        "- [Retained](wiki/archive/retained.md) - RETAINED-INDEX-MARKER",
        "- [Maintenance](wiki/_archive/retained.md) - MAINTENANCE-INDEX-MARKER",
      ].join("\n"),
    );
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory-retained",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("AgentMemory (wiki/projects/agentmemory.md)");
    expect(hook.stdout).toContain("[retained reference omitted]");
    expect(hook.stdout).not.toContain("raw/.compact-archive/");
    expect(hook.stdout).not.toContain("wiki/archive/");
    expect(hook.stdout).not.toContain("wiki/_archive/");
    expect(hook.stdout).not.toContain("RETAINED-INDEX-MARKER");
    expect(hook.stdout).not.toContain("MAINTENANCE-INDEX-MARKER");
  });

  it("session_start hook omits project sections for unknown cwd", async () => {
    await writeAntigravityProjectMemoryFixture(memDir);
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory-none",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\misc-claude-sessions",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("--- Schema");
    expect(hook.stdout).toContain("--- Index");
    expect(hook.stdout).not.toContain("--- Current project memory");
    expect(hook.stdout).not.toContain("--- Related memory");
  });

  it("session_start hook bounds oversized project memory", async () => {
    await writeAntigravityProjectMemoryFixture(
      memDir,
      `Memory-system Antigravity summary.\n\n${"oversized antigravity body ".repeat(500)}`,
    );
    const result = await installAntigravity({
      antigravityDir,
      antigravityVersion: "2.1.0",
    });
    const hookPath = join(result.pluginDir, "hooks", "session_start.mjs");

    const hook = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        sessionId: "project-memory-cap",
        timestamp: "2026-06-02T00:00:00.000Z",
        cwd: "C:\\Repos\\memory-system",
      }),
      encoding: "utf-8",
      env: { ...process.env, MEMORY_ROOT: memDir },
    });

    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain("(truncated, use MCP read_page for full)");
    const currentStart = hook.stdout.indexOf("--- Current project memory");
    const schemaStart = hook.stdout.indexOf("--- Schema");
    expect(currentStart).toBeGreaterThan(-1);
    expect(schemaStart).toBeGreaterThan(currentStart);
    expect(hook.stdout.slice(currentStart, schemaStart).trimEnd().length).toBeLessThanOrEqual(8000);
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

async function writeAntigravityProjectMemoryFixture(
  memDir: string,
  memorySystemBody = "Memory-system Antigravity summary.\n\nMemory-system Antigravity body should be emitted.",
): Promise<void> {
  await mkdir(join(memDir, "wiki", "projects"), { recursive: true });
  await writeFile(
    join(memDir, "wiki", "projects", "memory-system.md"),
    [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-05-20",
      "updated: 2026-06-02",
      "status: active",
      "relations:",
      "  linked:",
      "    - wiki/projects/agentmemory.md",
      "---",
      "",
      memorySystemBody,
      "",
    ].join("\n"),
  );
  await writeFile(
    join(memDir, "wiki", "projects", "agentmemory.md"),
    [
      "---",
      "type: projects",
      "title: AgentMemory",
      "created: 2026-05-20",
      "updated: 2026-06-01",
      "strength: 0.9",
      "---",
      "",
      "AgentMemory summary from index.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(memDir, "index.md"),
    [
      "# Index",
      "",
      "## Projects",
      "",
      "- [Memory System](wiki/projects/memory-system.md) - Memory-system Antigravity summary.",
      "- [AgentMemory](wiki/projects/agentmemory.md) - AgentMemory summary from index.",
      "",
    ].join("\n"),
  );
}
