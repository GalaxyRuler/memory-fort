import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runDisconnect } from "../../../src/cli/commands/disconnect.js";
import { installCodex } from "../../../src/cli/commands/install/codex.js";

describe("runDisconnect", () => {
  let tmp: string;
  let memDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "disconnect-"));
    memDir = join(tmp, ".memory");
    // Mirror uninstall.test.ts isolation: full-client disconnect must never
    // touch real ~/.claude, VS Code, etc.
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_REPO_DIR: process.env["MEMORY_REPO_DIR"],
      MEMORY_CLAUDE_DIR: process.env["MEMORY_CLAUDE_DIR"],
      MEMORY_CLAUDE_DESKTOP_DIR: process.env["MEMORY_CLAUDE_DESKTOP_DIR"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
      MEMORY_ANTIGRAVITY_DIR: process.env["MEMORY_ANTIGRAVITY_DIR"],
      MEMORY_HERMES_DIR: process.env["MEMORY_HERMES_DIR"],
      MEMORY_PI_DIR: process.env["MEMORY_PI_DIR"],
      MEMORY_OPENCLAW_DIR: process.env["MEMORY_OPENCLAW_DIR"],
      MEMORY_OPENCODE_DIR: process.env["MEMORY_OPENCODE_DIR"],
      OPENCODE_CONFIG_DIR: process.env["OPENCODE_CONFIG_DIR"],
      MEMORY_VSCODE_USER_DIR: process.env["MEMORY_VSCODE_USER_DIR"],
      MEMORY_VSCODE_EXTENSION_DIR: process.env["MEMORY_VSCODE_EXTENSION_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = join(tmp, "repo");
    process.env["MEMORY_CLAUDE_DIR"] = join(tmp, ".claude");
    process.env["MEMORY_CLAUDE_DESKTOP_DIR"] = join(tmp, "Claude");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    process.env["MEMORY_ANTIGRAVITY_DIR"] = join(tmp, ".gemini", "antigravity");
    process.env["MEMORY_HERMES_DIR"] = join(tmp, ".hermes");
    process.env["MEMORY_PI_DIR"] = join(tmp, ".pi");
    process.env["MEMORY_OPENCLAW_DIR"] = join(tmp, ".openclaw");
    process.env["MEMORY_OPENCODE_DIR"] = join(tmp, ".config", "opencode");
    process.env["OPENCODE_CONFIG_DIR"] = join(tmp, ".config", "opencode");
    process.env["MEMORY_VSCODE_USER_DIR"] = join(tmp, "Code", "User");
    process.env["MEMORY_VSCODE_EXTENSION_DIR"] = join(tmp, "extensions");
    await mkdir(join(tmp, "repo", "dist", "hooks"), { recursive: true });
    await writeFile(join(tmp, "repo", "package.json"), "{}\n");
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("disconnects one selected client by running the matching uninstaller", async () => {
    const codexConfig = join(process.env["MEMORY_CODEX_DIR"]!, "config.toml");
    const before = "[model]\nname = \"gpt-5\"\n";
    await mkdir(process.env["MEMORY_CODEX_DIR"]!, { recursive: true });
    await writeFile(codexConfig, before);
    await installCodex();

    const result = await runDisconnect({ client: "codex" });

    expect(result.exitCode).toBe(0);
    expect(result.clients).toEqual([
      expect.objectContaining({ client: "codex", ok: true }),
    ]);
    await expect(readFile(codexConfig, "utf-8")).resolves.toBe(before);
  });

  it("treats an absent selected client as a successful no-op", async () => {
    const result = await runDisconnect({ client: "codex" });

    expect(result.exitCode).toBe(0);
    expect(result.clients[0]).toMatchObject({ client: "codex", ok: true });
    expect(result.clients[0]?.detail).toContain("not installed");
  });

  it("preserves shared scripts after disconnecting every known client", async () => {
    // Workspace-scoped VS Code (and similar) may still reference launchers even
    // after user-level configs are removed; do not auto-delete scripts/.
    const scriptsDir = join(memDir, "claude-code-plugin", "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "mcp-server.mjs"), "// launcher\n");

    const result = await runDisconnect();

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(scriptsDir, "mcp-server.mjs"))).toBe(true);
  });

  it("preserves shared scripts when only one client is disconnected", async () => {
    const scriptsDir = join(memDir, "claude-code-plugin", "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "mcp-server.mjs"), "// launcher\n");

    await runDisconnect({ client: "codex" });

    expect(existsSync(join(scriptsDir, "mcp-server.mjs"))).toBe(true);
  });

  it("preserves shared scripts on full disconnect scoped to a VS Code workspace", async () => {
    const scriptsDir = join(memDir, "claude-code-plugin", "scripts");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, "mcp-server.mjs"), "// launcher\n");

    const result = await runDisconnect({ workspace: join(tmp, "some-workspace") });

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(scriptsDir, "mcp-server.mjs"))).toBe(true);
  });
});
