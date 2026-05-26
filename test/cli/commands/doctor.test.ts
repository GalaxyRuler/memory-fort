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
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
    };
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
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

  it("reports claude-code install check fail when manifest absent", async () => {
    await runInit({ sourceRepoDir: process.cwd() });
    const result = await runDoctor();
    const pluginCheck = result.checks.find((check) =>
      check.name.includes("plugin manifest"),
    );
    expect(pluginCheck!.ok).toBe(false);
    expect(pluginCheck!.hint).toContain("memory install claude-code");
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
