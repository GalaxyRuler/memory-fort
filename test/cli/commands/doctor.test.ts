import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runDoctor } from "../../../src/cli/commands/doctor.js";

describe("runDoctor", () => {
  let tmp: string;
  let origMem: string | undefined;
  let origEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "doc-"));
    origMem = process.env["MEMORY_ROOT"];
    origEnv = {
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
    };
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    for (const [key, value] of Object.entries(origEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("fails most checks when memory root does not exist", async () => {
    const result = await runDoctor();
    expect(result.failed).toBeGreaterThan(0);
    expect(result.checks[0]!.ok).toBe(false);
  });

  it("passes baseline checks after memory init", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const result = await runDoctor();
    expect(result.checks.find((check) => check.name.includes("~/.memory/"))!.ok).toBe(true);
    expect(result.checks.find((check) => check.name.includes("schema.md"))!.ok).toBe(true);
    expect(result.checks.find((check) => check.name.includes("config.yaml"))!.ok).toBe(true);
  });

  it("does not fail when embeddings directory is absent", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const memRoot = process.env["MEMORY_ROOT"]!;
    await rm(join(memRoot, "embeddings"), { recursive: true, force: true });

    const result = await runDoctor();

    const embeddingsCheck = result.checks.find((check) =>
      check.name.includes("embeddings"),
    );
    expect(embeddingsCheck!.ok).toBe(true);
    expect(embeddingsCheck!.hint).toContain("skipping vector");
    expect(result.failed).toBe(0);
  });

  it("accepts supported wiki-local crystals and archive directories", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const memRoot = process.env["MEMORY_ROOT"]!;
    await rm(join(memRoot, "crystals"), { recursive: true, force: true });
    await rm(join(memRoot, ".archive"), { recursive: true, force: true });
    await mkdir(join(memRoot, "wiki", "crystals"), { recursive: true });
    await mkdir(join(memRoot, "wiki", ".archive"), { recursive: true });

    const result = await runDoctor();

    expect(result.checks.find((check) => check.name.includes("crystals"))!.ok).toBe(true);
    expect(result.checks.find((check) => check.name.includes("archive"))!.ok).toBe(true);
  });

  it("accepts wiki archive directory when it is the only archive layout", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const memRoot = process.env["MEMORY_ROOT"]!;
    await rm(join(memRoot, ".archive"), { recursive: true, force: true });
    await rm(join(memRoot, "wiki", ".archive"), { recursive: true, force: true });
    await mkdir(join(memRoot, "wiki", "archive"), { recursive: true });

    const result = await runDoctor();

    expect(result.checks.find((check) => check.name.includes("archive"))!.ok).toBe(true);
  });

  it("does not fail claude-code plugin checks when Claude Code is absent", async () => {
    await runInit({ sourceRepoDir: process.cwd() });

    const result = await runDoctor();

    const claudeChecks = result.checks.filter((check) =>
      check.name.includes("claude-code"),
    );
    expect(claudeChecks.length).toBeGreaterThan(0);
    expect(claudeChecks.every((check) => check.ok)).toBe(true);
    expect(claudeChecks.every((check) => check.hint?.includes("not installed"))).toBe(
      true,
    );
  });

  it("reports claude-code install check fail when manifest absent and Claude Code is installed", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    await mkdir(process.env["MEMORY_CLAUDE_DIR"]!, { recursive: true });
    const result = await runDoctor();
    const pluginCheck = result.checks.find((check) =>
      check.name.includes("plugin manifest"),
    );
    expect(pluginCheck!.ok).toBe(false);
    expect(pluginCheck!.hint).toContain("memory install claude-code");
  });

  it("reports claude-code enabled check fail when plugin is not enabled", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const memRoot = process.env["MEMORY_ROOT"]!;
    await mkdir(join(memRoot, "claude-code-plugin", ".claude-plugin"), {
      recursive: true,
    });
    await writeFile(
      join(memRoot, "claude-code-plugin", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "memory" }),
    );
    await mkdir(process.env["MEMORY_CLAUDE_DIR"]!, { recursive: true });
    await writeFile(
      join(process.env["MEMORY_CLAUDE_DIR"]!, "settings.json"),
      JSON.stringify({ enabledPlugins: {} }),
    );

    const result = await runDoctor();

    const enabledCheck = result.checks.find((check) =>
      check.name.includes("claude-code plugin enabled"),
    );
    expect(enabledCheck!.ok).toBe(false);
    expect(enabledCheck!.hint).toContain("memory install claude-code");
  });

  it("flags errors.log larger than 100KB", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const memRoot = process.env["MEMORY_ROOT"]!;
    await writeFile(join(memRoot, "errors.log"), "x".repeat(200 * 1024));
    const result = await runDoctor();
    const errorsCheck = result.checks.find((check) => check.name.includes("errors.log"));
    expect(errorsCheck!.ok).toBe(false);
  });

  it("counts passed vs failed accurately", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const result = await runDoctor();
    expect(result.passed + result.failed).toBe(result.checks.length);
  });

  it("reports client connection status separately from structural checks", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    await mkdir(process.env["MEMORY_VSCODE_USER_DIR"]!, { recursive: true });
    await writeFile(
      join(process.env["MEMORY_VSCODE_USER_DIR"]!, "mcp.json"),
      JSON.stringify({
        servers: {
          memory: {
            type: "stdio",
            command: "node",
            args: ["C:/tmp/mcp-server.mjs"],
          },
        },
      }),
    );
    const result = await runDoctor();
    expect(result.clients.map((client) => client.client)).toContain("vscode");
    const vscode = result.clients.find((client) => client.client === "vscode")!;
    expect(vscode.state).toBe("installed");
  });
});
