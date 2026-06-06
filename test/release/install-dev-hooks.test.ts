import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const installerPath = resolve(process.cwd(), "scripts", "install-dev-hooks.mjs");
const expectedHook = [
  "#!/bin/sh",
  'remote="$1"',
  'if [ "$remote" = "origin" ]; then',
  "  node scripts/scan-leaks.mjs || exit 1",
  "fi",
  "",
].join("\n");

describe("install-dev-hooks", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "install-dev-hooks-"));
    await mkdir(join(tmp, ".git", "hooks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("installs an idempotent pre-push scan-leaks gate", async () => {
    const hookPath = join(tmp, ".git", "hooks", "pre-push");

    await runInstaller(tmp);

    const firstHook = await readFile(hookPath, "utf-8");
    expect(firstHook).toBe(expectedHook);
    if (process.platform !== "win32") {
      expect((await stat(hookPath)).mode & 0o111).not.toBe(0);
    }

    await runInstaller(tmp);

    const secondHook = await readFile(hookPath, "utf-8");
    expect(secondHook).toBe(firstHook);
    expect(secondHook.match(/node scripts\/scan-leaks\.mjs/g)).toHaveLength(1);
  });
});

async function runInstaller(cwd: string): Promise<void> {
  await execFileAsync(process.execPath, [installerPath], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
}
