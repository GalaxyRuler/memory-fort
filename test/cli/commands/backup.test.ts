import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createBackup,
  runRestoreDrill,
  verifyBackup,
  type BackupManifest,
} from "../../../src/cli/commands/backup.js";

const execFile = promisify(nodeExecFile);

describe("memory backup", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it("creates an internally manifested archive and verifies every restored byte", async () => {
    const harness = await createVaultHarness();

    const created = await createBackup({
      vaultRoot: harness.vaultRoot,
      targetDir: harness.targetDir,
      now: new Date("2026-07-23T08:09:10.123Z"),
    });
    const verified = await verifyBackup(created.archivePath);

    expect(created.archivePath).toMatch(/memory-fort-20260723T080910123Z\.tar\.gz$/u);
    expect(created.verified).toBe(true);
    expect(created.fileCount).toBeGreaterThan(3);
    expect(created.protectionClass).toBe("local-same-device");
    expect(verified).toMatchObject({
      archivePath: created.archivePath,
      archiveSha256: created.archiveSha256,
      manifestSha256: created.manifestSha256,
      fileCount: created.fileCount,
      totalBytes: created.totalBytes,
      gitVerified: true,
      protectionClass: "local-same-device",
    });
  });

  it("rejects an archive whose payload no longer matches its internal manifest", async () => {
    const harness = await createVaultHarness();
    const created = await createBackup({ vaultRoot: harness.vaultRoot, targetDir: harness.targetDir });
    const tampered = join(harness.targetDir, "tampered.tar.gz");

    await repackWithMutation(created.archivePath, tampered, async (root, manifest) => {
      const canaryPath = join(root, manifest.vault.archiveRoot, "wiki", "canary.md");
      const bytes = await readFile(canaryPath);
      bytes[0] = bytes[0] === 0x23 ? 0x24 : 0x23;
      await writeFile(canaryPath, bytes);
    });

    await expect(verifyBackup(tampered)).rejects.toThrow(/SHA-256 mismatch.*wiki\/canary\.md/iu);
  });

  it("restores only to a disposable directory, rebuilds the derived index, and finds known content", async () => {
    const harness = await createVaultHarness();
    const created = await createBackup({ vaultRoot: harness.vaultRoot, targetDir: harness.targetDir });
    const drillTempRoot = join(harness.root, "drill-work");
    await mkdir(drillTempRoot, { recursive: true });

    const receipt = await runRestoreDrill(created.archivePath, { tempRoot: drillTempRoot });

    expect(receipt).toMatchObject({
      archivePath: created.archivePath,
      gitVerified: true,
      indexRebuilt: true,
      canaryMatched: true,
      expectedPath: "wiki/canary.md",
      matchedPath: "wiki/canary.md",
      workspaceRemoved: true,
    });
    expect(receipt.indexedFiles).toBeGreaterThanOrEqual(1);
    expect(await readdir(drillTempRoot)).toEqual([]);
  });

  it("supports the VPS layout with a vault beside a bare Git repository", async () => {
    const root = await makeTempRoot("memory-backup-bare-");
    const work = join(root, "source-worktree");
    const vaultRoot = join(root, "vault");
    const repositoryRoot = join(root, "memory.git");
    const targetDir = join(root, "backup-target");
    await mkdir(join(work, "wiki"), { recursive: true });
    await writeFile(join(work, "wiki", "canary.md"), "# VPS\n\nVpsRestoreCanaryQuartz proves recovered search.\n", "utf8");
    await initGitRepository(work);
    await execFile("git", ["clone", "--bare", work, repositoryRoot], { windowsHide: true });
    await mkdir(join(vaultRoot, "wiki"), { recursive: true });
    await writeFile(join(vaultRoot, "wiki", "canary.md"), "# VPS\n\nVpsRestoreCanaryQuartz proves recovered search.\n", "utf8");
    await writeFile(join(vaultRoot, "raw-note.txt"), "untracked but canonical\n", "utf8");
    await mkdir(targetDir, { recursive: true });

    const created = await createBackup({ vaultRoot, repositoryRoot, targetDir });
    const verified = await verifyBackup(created.archivePath);

    expect(verified.gitMode).toBe("bare");
    expect(verified.gitVerified).toBe(true);
    expect(verified.fileCount).toBeGreaterThan(3);
  });

  it("routes the server timer through the same verifier and requires a separate mounted target", async () => {
    const script = await readFile(join(process.cwd(), "templates", "scripts", "memory-backup.sh"), "utf8");
    const service = await readFile(join(process.cwd(), "templates", "systemd", "memory-backup.service"), "utf8");

    expect(script).toContain('"$CLI_PATH" backup create');
    expect(script).toContain('"$CLI_PATH" backup verify');
    expect(script).toContain('"$CLI_PATH" backup drill');
    expect(script).toContain('--repository "${INSTALL_ROOT}/memory.git"');
    expect(script).toContain('[[ "$source_device" != "$target_device" ]]');
    expect(script).not.toContain('tar -tzf');
    expect(script).not.toContain('${INSTALL_ROOT}/env');
    expect(service).toContain("Environment=MEMORY_BACKUP_DIR=${BACKUP_DIR}");
    expect(service).toContain("Environment=MEMORY_NODE_PATH=${NODE_PATH}");
    expect(service).toContain("ReadWritePaths=${BACKUP_DIR} ${INSTALL_ROOT}/logs");
    expect(service).not.toContain("ReadWritePaths=${INSTALL_ROOT}/backups");
  });

  it("refuses a self-referential backup target inside the vault", async () => {
    const harness = await createVaultHarness();
    const nestedTarget = join(harness.vaultRoot, "backups");
    await mkdir(nestedTarget, { recursive: true });

    await expect(createBackup({ vaultRoot: harness.vaultRoot, targetDir: nestedTarget })).rejects.toThrow(
      /backup target must be outside the vault/iu,
    );
  });

  async function createVaultHarness(): Promise<{ root: string; vaultRoot: string; targetDir: string }> {
    const root = await makeTempRoot("memory-backup-");
    const vaultRoot = join(root, "vault");
    const targetDir = join(root, "backup-target");
    await mkdir(join(vaultRoot, "wiki"), { recursive: true });
    await mkdir(join(vaultRoot, "raw", "2026-07-23"), { recursive: true });
    await writeFile(
      join(vaultRoot, "wiki", "canary.md"),
      "# Recovery canary\n\nRestoreCanaryQuartz uniquely proves that the restored search index works.\n",
      "utf8",
    );
    await writeFile(join(vaultRoot, "raw", "2026-07-23", "capture.md"), "# Capture\n\nDurable raw evidence.\n", "utf8");
    await writeFile(join(vaultRoot, "config.yaml"), "embedder:\n  provider: lexical\n", "utf8");
    await initGitRepository(vaultRoot);
    await mkdir(targetDir, { recursive: true });
    return { root, vaultRoot, targetDir };
  }

  async function makeTempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    cleanup.push(root);
    return root;
  }
});

async function initGitRepository(root: string): Promise<void> {
  await execFile("git", ["init", "-q"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.name", "Backup Test"], { cwd: root, windowsHide: true });
  await execFile("git", ["config", "user.email", "backup-test@example.invalid"], { cwd: root, windowsHide: true });
  await execFile("git", ["add", "."], { cwd: root, windowsHide: true });
  await execFile("git", ["commit", "-q", "-m", "test: seed vault"], { cwd: root, windowsHide: true });
}

async function repackWithMutation(
  archivePath: string,
  outputPath: string,
  mutate: (root: string, manifest: BackupManifest) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "memory-backup-repack-"));
  try {
    await execFile("tar", ["-xzf", archivePath, "-C", root], { windowsHide: true });
    const manifest = JSON.parse(await readFile(join(root, "backup-manifest.json"), "utf8")) as BackupManifest;
    await mutate(root, manifest);
    await execFile("tar", ["-czf", outputPath, "-C", root, "."], { windowsHide: true });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
