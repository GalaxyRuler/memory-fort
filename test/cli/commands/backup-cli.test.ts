import { execFile as nodeExecFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(nodeExecFile);
const CLI = resolve(process.cwd(), "dist", "cli.mjs");

describe("built backup CLI", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { force: true, recursive: true });
    root = undefined;
  });

  it("creates, verifies, and drills a backup through the shipped entry point", async () => {
    root = await mkdtemp(join(tmpdir(), "memory-backup-cli-"));
    const vaultRoot = join(root, "vault");
    const targetDir = join(root, "target");
    await mkdir(join(vaultRoot, "wiki"), { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      join(vaultRoot, "wiki", "canary.md"),
      "# Shipped backup proof\n\nShippedRestoreCanaryQuartz proves the bundled CLI can rebuild search.\n",
      "utf8",
    );
    await initGitRepository(vaultRoot);

    const env = {
      MEMORY_ROOT: vaultRoot,
      MEMORY_SECRETS_PATH: join(root, "nonexistent-secrets.json"),
      MEMORY_EVIDENCE_SECURITY_DIR: join(root, "evidence-security"),
    };
    const createdRun = runCli(
      ["backup", "create", "--vault", vaultRoot, "--target", targetDir, "--json"],
      env,
    );
    expect(createdRun.code, createdRun.stderr).toBe(0);
    const created = JSON.parse(createdRun.stdout) as {
      archivePath: string;
      archiveSha256: string;
      manifestSha256: string;
      verified: boolean;
      offHostVerified: boolean;
    };
    expect(created).toMatchObject({ verified: true, offHostVerified: false });
    expect(created.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(created.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const verifiedRun = runCli(["backup", "verify", created.archivePath, "--json"], env);
    expect(verifiedRun.code, verifiedRun.stderr).toBe(0);
    expect(JSON.parse(verifiedRun.stdout)).toMatchObject({
      archivePath: created.archivePath,
      archiveSha256: created.archiveSha256,
      manifestSha256: created.manifestSha256,
      gitVerified: true,
    });

    const drillRun = runCli(["backup", "drill", created.archivePath, "--json"], env);
    expect(drillRun.code, drillRun.stderr).toBe(0);
    expect(JSON.parse(drillRun.stdout)).toMatchObject({
      archivePath: created.archivePath,
      gitVerified: true,
      indexRebuilt: true,
      canaryMatched: true,
      expectedPath: "wiki/canary.md",
      matchedPath: "wiki/canary.md",
      workspaceRemoved: true,
    });
  });
});

function runCli(
  args: string[],
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function initGitRepository(root: string): Promise<void> {
  await execFile("git", ["init", "-q"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.name", "Backup CLI Test"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.email", "backup-cli-test@example.invalid"], {
    cwd: root,
    windowsHide: true,
  });
  await execFile("git", ["add", "."], { cwd: root, windowsHide: true });
  await execFile("git", ["commit", "-q", "-m", "test: seed built CLI vault"], {
    cwd: root,
    windowsHide: true,
  });
}
