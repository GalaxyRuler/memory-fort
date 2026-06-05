import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallPi } from "../../../src/cli/commands/install/pi.js";
import { runUninstall } from "../../../src/cli/commands/uninstall.js";

describe("runInstallPi", () => {
  let tmp: string;
  let memDir: string;
  let piDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-pi-"));
    memDir = join(tmp, ".memory");
    piDir = join(tmp, ".pi");
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_PI_DIR: process.env["MEMORY_PI_DIR"],
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

  it("installs a Pi YAML hooks sentinel block in config.yaml", async () => {
    const result = await runInstallPi({ piDir });

    expect(result.configCreated).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    const content = await readFile(result.configPath, "utf-8");
    expect(content).toContain("# === BEGIN memory-system");
    expect(content).toContain("session_start:");
    expect(content).toContain("type: command");
    expect(content).toContain(`${memDir.replace(/\\/g, "/")}/hooks/session-start.mjs`);
    expect(content).toContain("session_end:");
    expect(content).not.toContain("mcp_servers:");
    expect(result.log.some((line) => line.includes("MCP"))).toBe(true);
  });

  it("replaces the prior block on re-install instead of duplicating it", async () => {
    await runInstallPi({ piDir });
    const result = await runInstallPi({ piDir });

    expect(result.priorBlockReplaced).toBe(true);
    const content = await readFile(result.configPath, "utf-8");
    expect(content.match(/# === BEGIN memory-system/g)).toHaveLength(1);
  });

  it("uninstall removes the block and restores original trailing newlines", async () => {
    const configPath = join(piDir, "config.yaml");
    const before = "model: local\nhooks:\n  existing: keep\n";
    await mkdir(piDir, { recursive: true });
    await writeFile(configPath, before);
    await runInstallPi({ piDir });

    const result = await runUninstall("pi", { piDir });

    expect(result.removed).toBe(true);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
  });

  it("respects MEMORY_PI_DIR when no option is provided", async () => {
    process.env["MEMORY_PI_DIR"] = piDir;

    const result = await runInstallPi();

    expect(result.configPath).toBe(join(piDir, "config.yaml"));
    expect(existsSync(result.configPath)).toBe(true);
  });

  it("preserves existing YAML keys around the sentinel", async () => {
    const configPath = join(piDir, "config.yaml");
    await mkdir(piDir, { recursive: true });
    await writeFile(configPath, "provider: ollama\nlimits:\n  max_turns: 40\n");

    await runInstallPi({ piDir });

    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("provider: ollama\n");
    expect(content).toContain("limits:\n  max_turns: 40\n");
    expect(content).toContain("# === BEGIN memory-system");
  });
});
