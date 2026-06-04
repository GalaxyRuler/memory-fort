import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runDisconnect } from "../../../src/cli/commands/disconnect.js";
import { installCodex } from "../../../src/cli/commands/install/codex.js";

describe("runDisconnect", () => {
  let tmp: string;
  let envBefore: Record<string, string | undefined>;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "disconnect-"));
    envBefore = {
      MEMORY_ROOT: process.env["MEMORY_ROOT"],
      MEMORY_CODEX_DIR: process.env["MEMORY_CODEX_DIR"],
    };
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
    process.env["MEMORY_CODEX_DIR"] = join(tmp, ".codex");
    await runInit({ sourceRepoDir: process.cwd() });
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
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
});
