import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../../src/cli/commands/init.js";
import { runDoctor } from "../../../src/cli/commands/doctor.js";

describe("runDoctor", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "doc-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = join(tmp, ".memory");
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
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
});
