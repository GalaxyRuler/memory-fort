import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallOpenClaw } from "../../../src/cli/commands/install/openclaw.js";
import { runUninstall } from "../../../src/cli/commands/uninstall.js";

describe("runInstallOpenClaw", () => {
  let tmp: string;
  let memDir: string;
  let openclawDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-openclaw-"));
    memDir = join(tmp, ".memory");
    openclawDir = join(tmp, ".openclaw");
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_OPENCLAW_DIR: process.env["MEMORY_OPENCLAW_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("installs mcpServers.memory in openclaw.json", async () => {
    const result = await runInstallOpenClaw({ openclawDir });

    expect(result.configCreated).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    const content = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(content.mcpServers.memory.command).toBe("node");
    expect(content.mcpServers.memory.args).toEqual([
      `${memDir.replace(/\\/g, "/")}/hooks/mcp-server.mjs`,
    ]);
  });

  it("is idempotent when re-installed", async () => {
    const first = await runInstallOpenClaw({ openclawDir });
    const firstContent = await readFile(first.configPath, "utf-8");
    const second = await runInstallOpenClaw({ openclawDir });
    const secondContent = await readFile(second.configPath, "utf-8");

    expect(second.memoryEntryAction).toBe("unchanged");
    expect(secondContent).toBe(firstContent);
  });

  it("uninstall removes only the memory key and preserves other keys", async () => {
    const configPath = join(openclawDir, "openclaw.json");
    const before = `${JSON.stringify({
      mcpServers: {
        other: { command: "node", args: ["other.mjs"] },
      },
      ui: { theme: "dark" },
    }, null, 2)}\n`;
    await mkdir(openclawDir, { recursive: true });
    await writeFile(configPath, before);
    await runInstallOpenClaw({ openclawDir });

    const result = await runUninstall("openclaw", { openclawDir });

    expect(result.removed).toBe(true);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
  });

  it("respects MEMORY_OPENCLAW_DIR when no option is provided", async () => {
    process.env["MEMORY_OPENCLAW_DIR"] = openclawDir;

    const result = await runInstallOpenClaw();

    expect(result.configPath).toBe(join(openclawDir, "openclaw.json"));
    expect(existsSync(result.configPath)).toBe(true);
  });

  it("creates openclaw.json when it is missing", async () => {
    const result = await runInstallOpenClaw({ openclawDir });

    expect(result.configCreated).toBe(true);
    const content = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(content.mcpServers.memory.command).toBe("node");
  });
});
