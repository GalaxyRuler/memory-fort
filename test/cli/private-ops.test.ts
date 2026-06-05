import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CLI = join(ROOT, "dist", "cli.mjs");
const PRIVATE_OPS_IMPORT_PATTERN = /import\("(\.\/private-ops-[^"]+\.mjs)"\)/;

function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    env: process.env,
  });

  return {
    code: result.status ?? -1,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function privateOpsChunkPath(): string {
  const cliSource = readFileSync(CLI, "utf-8");
  const match = PRIVATE_OPS_IMPORT_PATTERN.exec(cliSource);
  if (!match) {
    throw new Error("Unable to find private-ops dynamic import in dist/cli.mjs");
  }
  return resolve(dirname(CLI), match[1]);
}

describe("private CLI ops", () => {
  it("keeps private ops registered in the dev build", () => {
    const result = runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("install-vps");
    expect(result.stdout).toContain("install-tailscale-route");
    expect(result.stdout).toContain("sync-bootstrap");
    expect(result.stdout).toContain("sync");
    expect(result.stdout).toContain("pull");
    expect(result.stdout).toContain("push");
  });

  it("still parses public commands when private-ops is absent", () => {
    const privateOps = privateOpsChunkPath();
    const hiddenPrivateOps = `${privateOps}.hidden-for-test`;

    expect(existsSync(privateOps)).toBe(true);
    renameSync(privateOps, hiddenPrivateOps);
    try {
      const result = runCli(["--help"]);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("sync-prompts");
      expect(result.stdout).not.toContain("install-vps");
    } finally {
      renameSync(hiddenPrivateOps, privateOps);
    }
  });
});
