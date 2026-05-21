import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import {
  installCodex,
  stripPriorBlock,
} from "../../../src/cli/commands/install/codex.js";

describe("stripPriorBlock", () => {
  it("returns original content when no marker present", () => {
    const result = stripPriorBlock("[model]\nname = 'gpt-5'\n");
    expect(result.replaced).toBe(false);
    expect(result.content).toBe("[model]\nname = 'gpt-5'\n");
  });

  it("removes a complete BEGIN/END block in the middle", () => {
    const input = `[a]\nfoo = 1\n\n# === BEGIN memory-system v0.1.0 ===\n[[hooks.SessionStart]]\n# === END memory-system v0.1.0 ===\n\n[b]\nbar = 2\n`;
    const result = stripPriorBlock(input);
    expect(result.replaced).toBe(true);
    expect(result.content).toContain("[a]");
    expect(result.content).toContain("[b]");
    expect(result.content).not.toContain("[[hooks.SessionStart]]");
  });

  it("leaves content alone if BEGIN present but END missing", () => {
    const input = `[a]\n# === BEGIN memory-system v0.1.0 ===\n[[hooks.x]]\n[b]\n`;
    const result = stripPriorBlock(input);
    expect(result.replaced).toBe(false);
    expect(result.content).toBe(input);
  });
});

describe("installCodex", () => {
  let tmp: string;
  let memDir: string;
  let codexDir: string;
  let origMem: string | undefined;
  let origCodex: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "instcdx-"));
    memDir = join(tmp, ".memory");
    codexDir = join(tmp, ".codex");
    origMem = process.env["MEMORY_ROOT"];
    origCodex = process.env["MEMORY_CODEX_DIR"];
    process.env["MEMORY_ROOT"] = memDir;
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    if (origCodex === undefined) delete process.env["MEMORY_CODEX_DIR"];
    else process.env["MEMORY_CODEX_DIR"] = origCodex;
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates config.toml when absent", async () => {
    const result = await installCodex({ codexDir });
    expect(result.configCreated).toBe(true);
    expect(existsSync(result.codexConfigPath)).toBe(true);
    const content = await readFile(result.codexConfigPath, "utf-8");
    expect(content).toContain("# === BEGIN memory-system");
    expect(content).toContain("[[hooks.SessionStart]]");
    expect(content).toContain("[mcp_servers.memory]");
  });

  it("preserves existing config content when appending", async () => {
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "config.toml"),
      `[model]\nname = "gpt-5"\n# user comment\n`,
    );
    const result = await installCodex({ codexDir });
    const content = await readFile(result.codexConfigPath, "utf-8");
    expect(content).toContain("[model]");
    expect(content).toContain("# user comment");
    expect(content).toContain("[[hooks.SessionStart]]");
    expect(result.priorBlockReplaced).toBe(false);
  });

  it("replaces prior block on re-install", async () => {
    await installCodex({ codexDir });
    const result = await installCodex({ codexDir });
    expect(result.priorBlockReplaced).toBe(true);
    const content = await readFile(result.codexConfigPath, "utf-8");
    const beginCount = (content.match(/# === BEGIN memory-system/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it("preserves user content when replacing block", async () => {
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, "config.toml"), `[model]\nname = "gpt-5"\n`);
    await installCodex({ codexDir });
    await installCodex({ codexDir });
    const content = await readFile(join(codexDir, "config.toml"), "utf-8");
    expect(content).toContain("[model]");
    expect((content.match(/# === BEGIN memory-system/g) ?? []).length).toBe(1);
  });

  it("appends to log.md", async () => {
    await installCodex({ codexDir });
    const log = await readFile(join(memDir, "log.md"), "utf-8");
    expect(log).toContain("install | codex");
  });

  it("config block references the claude-code-plugin scripts dir", async () => {
    const result = await installCodex({ codexDir });
    const content = await readFile(result.codexConfigPath, "utf-8");
    expect(content).toContain("claude-code-plugin/scripts/session-start.mjs");
    expect(content).toContain("claude-code-plugin/scripts/mcp-server.mjs");
  });

  it("MCP entry uses absolute path and not ${CLAUDE_PLUGIN_ROOT}", async () => {
    const result = await installCodex({ codexDir });
    const content = await readFile(result.codexConfigPath, "utf-8");
    const mcpSection = content.slice(content.indexOf("[mcp_servers.memory]"));
    expect(mcpSection).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(mcpSection).toMatch(/args\s*=\s*\["[A-Z]:/);
  });

  it("uses MEMORY_CODEX_DIR when codexDir is not provided", async () => {
    process.env["MEMORY_CODEX_DIR"] = codexDir;
    const result = await installCodex();
    expect(result.codexConfigPath).toBe(join(codexDir, "config.toml"));
    expect(existsSync(result.codexConfigPath)).toBe(true);
  });
});
