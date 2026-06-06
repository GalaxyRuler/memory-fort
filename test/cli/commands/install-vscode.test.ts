import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { installVsCode, resolveVsCodeUserDir } from "../../../src/cli/commands/install/vscode.js";

describe("installVsCode", () => {
  let tmp: string;
  let memDir: string;
  let userDir: string;
  let workspaceDir: string;
  let extensionDir: string;
  let origMem: string | undefined;
  let origUserDir: string | undefined;
  let origAppData: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-vscode-"));
    memDir = join(tmp, ".memory");
    userDir = join(tmp, "Code", "User");
    workspaceDir = join(tmp, "workspace");
    extensionDir = join(tmp, "extensions");
    origMem = process.env["MEMORY_ROOT"];
    origUserDir = process.env["MEMORY_VSCODE_USER_DIR"];
    origAppData = process.env["APPDATA"];
    process.env["MEMORY_ROOT"] = memDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origUserDir === undefined) delete process.env["MEMORY_VSCODE_USER_DIR"];
    else process.env["MEMORY_VSCODE_USER_DIR"] = origUserDir;
    if (origAppData === undefined) delete process.env["APPDATA"];
    else process.env["APPDATA"] = origAppData;
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("creates user-profile mcp.json when absent", async () => {
    const result = await installVsCode({ userDir, extensionDir, installed: true });
    expect(result.status).toBe("installed");
    expect(result.scope).toBe("global");
    expect(result.extensionPath).toBe(join(extensionDir, "memory-fort.memory"));
    expect(existsSync(result.configPath!)).toBe(true);
    const content = JSON.parse(await readFile(result.configPath!, "utf-8"));
    expect(content.servers.memory.type).toBe("stdio");
    expect(content.servers.memory.command).toBe("node");
    expect(content.servers.memory.args[0]).toContain("mcp-server.mjs");
  });

  it("merges global mcp.json preserving other servers", async () => {
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "mcp.json"),
      JSON.stringify({
        servers: {
          other: { type: "stdio", command: "node", args: ["other.mjs"] },
        },
        inputs: [{ id: "token", type: "promptString" }],
      }),
    );

    const result = await installVsCode({ userDir, extensionDir, installed: true });
    const content = JSON.parse(await readFile(result.configPath!, "utf-8"));
    expect(content.servers.other).toBeDefined();
    expect(content.servers.memory).toBeDefined();
    expect(content.inputs).toEqual([{ id: "token", type: "promptString" }]);
  });

  it("replaces the memory entry on reinstall", async () => {
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "mcp.json"),
      JSON.stringify({ servers: { memory: { command: "old" } } }),
    );
    const result = await installVsCode({ userDir, extensionDir, installed: true });
    expect(result.memoryEntryAction).toBe("updated");
    const content = JSON.parse(await readFile(result.configPath!, "utf-8"));
    expect(content.servers.memory.command).toBe("node");
    expect(content.servers.memory.args[0]).toContain("mcp-server.mjs");
  });

  it("writes workspace-scoped .vscode/mcp.json when workspace is provided", async () => {
    const result = await installVsCode({
      userDir,
      extensionDir,
      workspace: workspaceDir,
      installed: true,
    });
    expect(result.scope).toBe("workspace");
    expect(result.configPath).toBe(join(workspaceDir, ".vscode", "mcp.json"));
    const content = JSON.parse(await readFile(result.configPath!, "utf-8"));
    expect(content.servers.memory.command).toBe("node");
  });

  it("skips gracefully when VS Code is not installed", async () => {
    const result = await installVsCode({ userDir, installed: false });
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("VS Code not found");
    expect(existsSync(join(userDir, "mcp.json"))).toBe(false);
  });

  it("uses MEMORY_VSCODE_USER_DIR when userDir is not provided", async () => {
    process.env["MEMORY_VSCODE_USER_DIR"] = userDir;
    const result = await installVsCode({ extensionDir, installed: true });
    expect(result.configPath).toBe(join(userDir, "mcp.json"));
  });

  it("resolves the Windows VS Code user directory from APPDATA", () => {
    expect(
      resolveVsCodeUserDir({
        env: { APPDATA: join(tmp, "Roaming") },
        homeDir: homedir(),
        platform: "win32",
      }),
    ).toBe(join(tmp, "Roaming", "Code", "User"));
  });

  it("resolves the macOS VS Code user directory from the home Library path", () => {
    expect(
      resolveVsCodeUserDir({
        env: { APPDATA: join(tmp, "Roaming") },
        homeDir: homedir(),
        platform: "darwin",
      }),
    ).toBe(join(homedir(), "Library", "Application Support", "Code", "User"));
  });

  it("resolves the Linux VS Code user directory from XDG-style config path", () => {
    expect(
      resolveVsCodeUserDir({
        env: { APPDATA: join(tmp, "Roaming") },
        homeDir: homedir(),
        platform: "linux",
      }),
    ).toBe(join(homedir(), ".config", "Code", "User"));
  });

  it("installs the bundled Memory Fort VS Code extension", async () => {
    const result = await installVsCode({
      userDir,
      extensionDir,
      installed: true,
    });

    expect(result.extensionInstalled).toBe(true);
    expect(result.extensionPath).toBe(join(extensionDir, "memory-fort.memory"));
    const manifest = JSON.parse(
      await readFile(join(result.extensionPath!, "package.json"), "utf-8"),
    );
    expect(manifest.name).toBe("memory");
    expect(manifest.publisher).toBe("memory-fort");
    expect(manifest.contributes.chatParticipants[0].id).toBe("memory-fort.memory");
    expect(existsSync(join(result.extensionPath!, "src", "extension.ts"))).toBe(true);
  });
});
