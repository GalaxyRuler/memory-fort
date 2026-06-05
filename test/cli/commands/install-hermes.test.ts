import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallHermes } from "../../../src/cli/commands/install/hermes.js";
import { runUninstall } from "../../../src/cli/commands/uninstall.js";

describe("runInstallHermes", () => {
  let tmp: string;
  let memDir: string;
  let hermesDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-hermes-"));
    memDir = join(tmp, ".memory");
    hermesDir = join(tmp, ".hermes");
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_HERMES_DIR: process.env["MEMORY_HERMES_DIR"],
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

  it("installs a sentinel block in config.yaml", async () => {
    const result = await runInstallHermes({ hermesDir });

    expect(result.configCreated).toBe(true);
    expect(existsSync(result.configPath)).toBe(true);
    const content = await readFile(result.configPath, "utf-8");
    expect(content).toContain("# === BEGIN memory-system");
    expect(content).toContain("on_session_start:");
    expect(content).toContain(`${memDir.replace(/\\/g, "/")}/hooks/session-start.mjs`);
    expect(content).toContain("mcp_servers:");
    expect(content).toContain("mcp-server.mjs");
  });

  it("replaces the prior block on re-install instead of duplicating it", async () => {
    await runInstallHermes({ hermesDir });
    const result = await runInstallHermes({ hermesDir });

    expect(result.priorBlockReplaced).toBe(true);
    const content = await readFile(result.configPath, "utf-8");
    expect(content.match(/# === BEGIN memory-system/g)).toHaveLength(1);
  });

  it("uninstall removes the block and restores original trailing newlines", async () => {
    const configPath = join(hermesDir, "config.yaml");
    const before = "theme: dark\nmodel: hermes-3\n\n";
    await mkdir(hermesDir, { recursive: true });
    await writeFile(configPath, before);
    await runInstallHermes({ hermesDir });

    const result = await runUninstall("hermes", { hermesDir });

    expect(result.removed).toBe(true);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
  });

  it("respects MEMORY_HERMES_DIR when no option is provided", async () => {
    process.env["MEMORY_HERMES_DIR"] = hermesDir;

    const result = await runInstallHermes();

    expect(result.configPath).toBe(join(hermesDir, "config.yaml"));
    expect(existsSync(result.configPath)).toBe(true);
  });

  it("preserves existing YAML keys around the sentinel", async () => {
    const configPath = join(hermesDir, "config.yaml");
    await mkdir(hermesDir, { recursive: true });
    await writeFile(configPath, "model: hermes-3\ntelemetry:\n  enabled: false\n");

    await runInstallHermes({ hermesDir });

    const content = await readFile(configPath, "utf-8");
    expect(content).toContain("model: hermes-3\n");
    expect(content).toContain("telemetry:\n  enabled: false\n");
    expect(content).toContain("# === BEGIN memory-system");
  });
});
