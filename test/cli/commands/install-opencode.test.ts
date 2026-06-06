import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstallOpenCode } from "../../../src/cli/commands/install/opencode.js";
import { runUninstall } from "../../../src/cli/commands/uninstall.js";

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

describe("runInstallOpenCode", () => {
  let tmp: string;
  let memDir: string;
  let repoDir: string;
  let opencodeDir: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-opencode-"));
    memDir = join(tmp, ".memory");
    repoDir = join(tmp, "repo");
    opencodeDir = join(tmp, ".config", "opencode");
    await mkdir(join(memDir, "hooks"), { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "package.json"), "{}");
    await writeFile(join(memDir, "hooks", "mcp-server.mjs"), "// mcp stub\n");
    await writeFile(join(memDir, "hooks", "opencode-event.mjs"), "// event stub\n");

    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_REPO_DIR: process.env["MEMORY_REPO_DIR"],
      MEMORY_OPENCODE_DIR: process.env["MEMORY_OPENCODE_DIR"],
    };
    process.env["MEMORY_ROOT"] = memDir;
    process.env["MEMORY_REPO_DIR"] = repoDir;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("installs local MCP and global plugin files", async () => {
    const memoryRoot = posixPath(memDir);
    const result = await runInstallOpenCode({ opencodeDir });

    expect(result.configPath).toBe(join(opencodeDir, "opencode.json"));
    expect(result.pluginPath).toBe(join(opencodeDir, "plugins", "memory-fort.js"));
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(result.pluginPath)).toBe(true);

    const config = JSON.parse(await readFile(result.configPath, "utf-8"));
    expect(config.mcp.memory).toEqual({
      type: "local",
      command: ["node", `${memoryRoot}/hooks/mcp-server.mjs`],
      enabled: true,
    });

    const plugin = await readFile(result.pluginPath, "utf-8");
    expect(plugin).toContain("MemoryFortOpenCode");
    expect(plugin).toContain(`${memoryRoot}/hooks/opencode-event.mjs`);
  });

  it("preserves existing config and is idempotent", async () => {
    const configPath = join(opencodeDir, "opencode.json");
    await mkdir(opencodeDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "system",
        mcp: {
          other: {
            type: "local",
            command: ["node", "other.mjs"],
            enabled: false,
          },
        },
        tools: {
          write: false,
        },
      }, null, 2)}\n`,
    );

    await runInstallOpenCode({ opencodeDir });
    const firstContent = await readFile(configPath, "utf-8");
    const second = await runInstallOpenCode({ opencodeDir });
    const secondContent = await readFile(configPath, "utf-8");

    const config = JSON.parse(secondContent);
    expect(config.theme).toBe("system");
    expect(config.tools.write).toBe(false);
    expect(config.mcp.other).toEqual({
      type: "local",
      command: ["node", "other.mjs"],
      enabled: false,
    });
    expect(config.mcp.memory).toBeDefined();
    expect(second.memoryEntryAction).toBe("unchanged");
    expect(secondContent).toBe(firstContent);
  });

  it("respects MEMORY_OPENCODE_DIR when no option is provided", async () => {
    process.env["MEMORY_OPENCODE_DIR"] = opencodeDir;

    const result = await runInstallOpenCode();

    expect(result.configPath).toBe(join(opencodeDir, "opencode.json"));
    expect(result.pluginPath).toBe(join(opencodeDir, "plugins", "memory-fort.js"));
    expect(existsSync(result.configPath)).toBe(true);
    expect(existsSync(result.pluginPath)).toBe(true);
  });

  it("throws on malformed opencode.json", async () => {
    const configPath = join(opencodeDir, "opencode.json");
    const pluginDir = join(opencodeDir, "plugins");
    const pluginPath = join(pluginDir, "memory-fort.js");
    const teamPluginPath = join(pluginDir, "team-plugin.js");
    const malformedConfig = "not json {";
    const teamPlugin = "// team plugin\n";
    await mkdir(pluginDir, { recursive: true });
    await writeFile(configPath, malformedConfig);
    await writeFile(teamPluginPath, teamPlugin);

    await expect(runInstallOpenCode({ opencodeDir })).rejects.toThrow(
      /memory install opencode: failed to parse existing config/i,
    );
    await expect(readFile(configPath, "utf-8")).resolves.toBe(malformedConfig);
    await expect(readFile(teamPluginPath, "utf-8")).resolves.toBe(teamPlugin);
    expect(existsSync(pluginPath)).toBe(false);
  });

  it("uninstall removes only Memory Fort entries", async () => {
    const configPath = join(opencodeDir, "opencode.json");
    const before = `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        other: {
          type: "local",
          command: ["node", "other.mjs"],
          enabled: true,
        },
      },
      tools: {
        write: false,
      },
    }, null, 2)}\n`;
    await mkdir(join(opencodeDir, "plugins"), { recursive: true });
    await writeFile(configPath, before);
    await writeFile(join(opencodeDir, "plugins", "team-plugin.js"), "// keep\n");
    const install = await runInstallOpenCode({ opencodeDir });

    const result = await runUninstall("opencode", { opencodeDir });

    expect(result.exitCode).toBe(0);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(before);
    expect(existsSync(install.pluginPath)).toBe(false);
    expect(existsSync(join(opencodeDir, "plugins", "team-plugin.js"))).toBe(true);
  });
});
