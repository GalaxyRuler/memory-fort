import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBackup,
  runRestoreDrill,
  type RestoreDrillEvidence,
} from "../../../src/cli/commands/backup.js";
import { runForget } from "../../../src/cli/commands/forget.js";
import {
  PURGE_HISTORY_CONFIRMATION,
  runHistoryPurge,
} from "../../../src/forget/history-purge.js";

const execFileAsync = promisify(execFile);
const FORGOTTEN_RAW = "raw/2026-07-23/codex-selected.md";
const FORGOTTEN_MARKER = "SYNTHETIC-FORGOTTEN-MARKER-7E2A";
const RETAINED_MARKER = "SYNTHETIC-RETAINED-MARKER-91C4";
const SCOPED_REFS = ["refs/heads/main", "refs/heads/auxiliary"] as const;

interface PurgeFixture {
  readonly tmp: string;
  readonly canonicalRoot: string;
  readonly cloneRoot: string;
  readonly backupArchivePath: string;
  readonly drillEvidencePath: string;
  readonly liveEraseReceiptPath: string;
  readonly originalMain: string;
  readonly originalAuxiliary: string;
  readonly originalRemoteMain: string;
  readonly originalRemoteAuxiliary: string;
  readonly backupArchiveSha256: string;
}

describe("memory forget --purge-history", () => {
  let fixture: PurgeFixture;
  let previousMemoryRoot: string | undefined;
  let previousIndexPath: string | undefined;
  let previousSpoolDir: string | undefined;

  beforeEach(async () => {
    previousMemoryRoot = process.env["MEMORY_ROOT"];
    previousIndexPath = process.env["MEMORY_INDEX_DB_PATH"];
    previousSpoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    fixture = await makePurgeFixture();
  });

  afterEach(async () => {
    if (previousMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousMemoryRoot;
    if (previousIndexPath === undefined) delete process.env["MEMORY_INDEX_DB_PATH"];
    else process.env["MEMORY_INDEX_DB_PATH"] = previousIndexPath;
    if (previousSpoolDir === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpoolDir;
    await rm(fixture.tmp, { recursive: true, force: true });
  });

  it("fails closed for missing, failed, stale, mismatched, or wrong-selection evidence", async () => {
    const originalMain = await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"]);
    const base = purgeOptions(fixture);

    await expect(runHistoryPurge({
      ...base,
      liveEraseReceiptPath: join(fixture.tmp, "missing-live-erase.json"),
    })).rejects.toThrow(/live erase receipt.*missing/i);


    const originalLiveReceipt = await readFile(fixture.liveEraseReceiptPath, "utf8");
    const failedLiveReceipt = JSON.parse(originalLiveReceipt) as { status: string };
    failedLiveReceipt.status = "partial-live-mutation/rebuild-incomplete";
    await writeFile(fixture.liveEraseReceiptPath, `${JSON.stringify(failedLiveReceipt, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/live erase receipt.*completed successful/i);
    await writeFile(fixture.liveEraseReceiptPath, originalLiveReceipt);

    const generationPath = join(fixture.canonicalRoot, "var", "index-generation");
    const originalGeneration = await readFile(generationPath, "utf8");
    await writeFile(generationPath, "invalidating:pending-purge-test\n");
    await expect(runHistoryPurge(base)).rejects.toThrow(/pending index invalidation/i);
    await writeFile(generationPath, originalGeneration);

    const recoveryPath = join(fixture.canonicalRoot, "var", "forget-recovery.json");
    await writeFile(recoveryPath, `${JSON.stringify({
      version: 1,
      indexInvalidatingToken: "pending-purge-test",
      epochs: [],
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/pending recovery/i);
    await rm(recoveryPath);
    const originalEvidence = await readFile(fixture.drillEvidencePath, "utf8");
    const evidence = JSON.parse(originalEvidence) as RestoreDrillEvidence;
    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      checks: { ...evidence.checks, canaryMatched: false },
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*passed/i);

    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      completedAt: "2026-07-01T00:00:00.000Z",
    }, null, 2)}\n`);
    await expect(runHistoryPurge({
      ...base,
      now: new Date("2026-07-24T12:00:00.000Z"),
    })).rejects.toThrow(/restore drill evidence.*stale/i);

    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      repository: {
        ...evidence.repository,
        fingerprint: "sha256:mismatched-repository",
      },
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/repository fingerprint/i);

    await writeFile(fixture.drillEvidencePath, originalEvidence);
    await expect(runHistoryPurge({
      ...base,
      rawPaths: ["raw/2026-07-23/codex-other.md"],
    })).rejects.toThrow(/exact live erase selection/i);

    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"])).toBe(originalMain);
  });

  it("requires the exact consequence phrase and a clean, separate disposable clone", async () => {
    const base = purgeOptions(fixture);
    const planned = await runHistoryPurge(base);
    expect(planned.status).toBe("planned");
    expect(planned.report).toContain(`Required confirmation: ${PURGE_HISTORY_CONFIRMATION}`);
    expect(planned.report).toContain(`- ${FORGOTTEN_RAW}`);
    expect(planned.report).toContain("- refs/heads/main");
    expect(planned.report).toContain("- refs/heads/auxiliary");

    await expect(runHistoryPurge({
      ...base,
      confirmation: "PURGE IT",
    })).rejects.toThrow(/confirmation phrase/i);

    await expect(runHistoryPurge({
      ...base,
      disposableClone: false,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    })).rejects.toThrow(/--disposable-clone/i);

    await writeFile(join(fixture.cloneRoot, "dirty.txt"), "not clean\n");
    await expect(runHistoryPurge({
      ...base,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    })).rejects.toThrow(/working tree and index must be clean/i);
    await rm(join(fixture.cloneRoot, "dirty.txt"));

    const gitDir = await git(fixture.cloneRoot, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(join(gitDir, "MERGE_HEAD"), `${fixture.originalMain}\n`);
    await expect(runHistoryPurge({
      ...base,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    })).rejects.toThrow(/unsafe Git operation.*MERGE_HEAD/i);
    await rm(join(gitDir, "MERGE_HEAD"));

    await expect(runHistoryPurge({
      ...base,
      repositoryRoot: fixture.canonicalRoot,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    })).rejects.toThrow(/canonical repository/i);
  });

  it("rewrites only itemized local heads, preserves unrelated history, and records truthful limits", async () => {
    const base = purgeOptions(fixture);
    const result = await runHistoryPurge({
      ...base,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    });

    expect(result.status).toBe("purged-local-history/limited-scope");
    expect(result.refs.map((ref) => ref.name)).toEqual([...SCOPED_REFS]);
    expect(result.refs.every((ref) => ref.before !== ref.after)).toBe(true);
    expect(result.receiptPath).toBeTruthy();
    expect(existsSync(result.receiptPath!)).toBe(true);

    expect(await git(fixture.cloneRoot, [
      "rev-list",
      ...SCOPED_REFS,
      "--",
      FORGOTTEN_RAW,
    ])).toBe("");
    expect(await git(fixture.cloneRoot, [
      "rev-list",
      ...SCOPED_REFS,
      "--",
      "raw/.compact-archive/2026-07-24/2026-07-23/codex-selected.md",
    ])).toBe("");
    expect(existsSync(join(fixture.cloneRoot, ...FORGOTTEN_RAW.split("/")))).toBe(false);

    const scopedHistory = await git(fixture.cloneRoot, [
      "log",
      ...SCOPED_REFS,
      "--format=%H",
      "-S",
      FORGOTTEN_MARKER,
    ]);
    expect(scopedHistory).toBe("");
    expect(await readFile(join(fixture.cloneRoot, "raw", "2026-07-23", "codex-other.md"), "utf8"))
      .toContain(RETAINED_MARKER);
    const retainedHistory = await git(fixture.cloneRoot, [
      "log",
      "refs/heads/main",
      "--format=%H",
      "-S",
      RETAINED_MARKER,
    ]);
    expect(retainedHistory).not.toBe("");

    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/remotes/origin/main"]))
      .toBe(fixture.originalRemoteMain);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/remotes/origin/auxiliary"]))
      .toBe(fixture.originalRemoteAuxiliary);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/remotes/origin/main"]))
      .toBe(fixture.originalMain);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/remotes/origin/auxiliary"]))
      .toBe(fixture.originalAuxiliary);

    expect(existsSync(fixture.backupArchivePath)).toBe(true);
    expect(existsSync(fixture.drillEvidencePath)).toBe(true);
    expect(await sha256File(fixture.backupArchivePath)).toBe(fixture.backupArchiveSha256);

    const receiptText = await readFile(result.receiptPath!, "utf8");
    const receipt = JSON.parse(receiptText) as {
      status: string;
      limitations: string[];
      refs: Array<{ name: string; before: string; after: string }>;
      validation: { passed: boolean; commands: Array<{ result: string }> };
    };
    expect(receipt.status).toBe("purged-local-history/limited-scope");
    expect(receipt.refs).toEqual(result.refs);
    expect(receipt.validation.passed).toBe(true);
    expect(receipt.validation.commands.every((command) => command.result === "passed")).toBe(true);
    expect(receipt.limitations).toEqual(expect.arrayContaining([
      expect.stringMatching(/remote refs and hosted repositories were not updated/i),
      expect.stringMatching(/other clones were not purged/i),
      expect.stringMatching(/reflogs were retained/i),
      expect.stringMatching(/backup archives and manifests were not deleted/i),
      expect.stringMatching(/unreachable objects remain until manual garbage collection/i),
    ]));
    expect(receiptText).not.toContain(FORGOTTEN_MARKER);
    expect(result.report).not.toContain(FORGOTTEN_MARKER);
  });
});

function purgeOptions(fixture: PurgeFixture) {
  return {
    repositoryRoot: fixture.cloneRoot,
    rawPaths: [FORGOTTEN_RAW],
    refs: [...SCOPED_REFS],
    liveEraseReceiptPath: fixture.liveEraseReceiptPath,
    restoreDrillEvidencePath: fixture.drillEvidencePath,
    disposableClone: true,
  };
}

async function makePurgeFixture(): Promise<PurgeFixture> {
  const tmp = await mkdtemp(join(tmpdir(), "forget-history-"));
  const canonicalRoot = join(tmp, "canonical");
  const cloneRoot = join(tmp, "disposable-clone");
  const backupRoot = join(tmp, "backups");
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  await git(canonicalRoot, ["init", "-b", "main"]);
  await git(canonicalRoot, ["config", "user.name", "History Purge Fixture"]);
  await git(canonicalRoot, ["config", "user.email", "history-purge@example.invalid"]);
  await writeAt(canonicalRoot, FORGOTTEN_RAW, [
    "---",
    "source: codex",
    "---",
    FORGOTTEN_MARKER,
    "",
  ].join("\n"));
  await writeAt(
    canonicalRoot,
    "raw/2026-07-23/codex-other.md",
    `---\nsource: codex-other\n---\n${RETAINED_MARKER}\n`,
  );
  await writeAt(
    canonicalRoot,
    "facts/2026-07-23/session.json",
    `${JSON.stringify([
      { sourceRawPath: FORGOTTEN_RAW, fact: FORGOTTEN_MARKER },
      { sourceRawPath: "raw/2026-07-23/codex-other.md", fact: RETAINED_MARKER },
    ], null, 2)}\n`,
  );
  await writeAt(
    canonicalRoot,
    "wiki/projects/selected.md",
    [
      "---",
      "type: projects",
      "title: Synthetic selected derivative",
      "generated_by: memory-fort",
      "source_facts:",
      `  - ${FORGOTTEN_RAW}#fact-1`,
      "---",
      FORGOTTEN_MARKER,
      "",
    ].join("\n"),
  );
  await git(canonicalRoot, ["add", "."]);
  await git(canonicalRoot, ["commit", "-m", "seed selected and retained fixture content"]);
  const firstCommit = await git(canonicalRoot, ["rev-parse", "HEAD"]);
  await git(canonicalRoot, ["branch", "auxiliary", firstCommit]);

  await writeAt(
    canonicalRoot,
    "raw/.compact-archive/2026-07-24/2026-07-23/codex-selected.md",
    `${FORGOTTEN_MARKER}\n`,
  );
  await writeAt(
    canonicalRoot,
    "raw/2026-07-23/codex-other.md",
    `---\nsource: codex-other\n---\n${RETAINED_MARKER}\nretained second revision\n`,
  );
  await git(canonicalRoot, ["add", "."]);
  await git(canonicalRoot, ["commit", "-m", "add retained revision and selected archive"]);

  const backup = await createBackup({
    vaultRoot: canonicalRoot,
    targetDir: backupRoot,
    now: new Date("2026-07-24T10:00:00.000Z"),
    tempRoot: join(tmp, "backup-work"),
  });
  const drill = await runRestoreDrill(backup.archivePath, {
    now: new Date("2026-07-24T10:05:00.000Z"),
    tempRoot: join(tmp, "drill-work"),
  });

  process.env["MEMORY_ROOT"] = canonicalRoot;
  process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "live-index.db");
  process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(tmp, "capture-spool");
  const liveErase = await runForget({
    mode: "apply",
    rawPaths: [FORGOTTEN_RAW],
    now: new Date("2026-07-24T10:10:00.000Z"),
  });
  expect(liveErase.status).toBe("live-erased/history-retained");
  expect(liveErase.receipt?.path).toBeTruthy();

  await git(tmp, ["clone", "--no-local", canonicalRoot, cloneRoot]);
  await git(cloneRoot, ["config", "user.name", "History Purge Fixture"]);
  await git(cloneRoot, ["config", "user.email", "history-purge@example.invalid"]);
  await git(cloneRoot, ["branch", "auxiliary", "refs/remotes/origin/auxiliary"]);

  return {
    tmp,
    canonicalRoot,
    cloneRoot,
    backupArchivePath: backup.archivePath,
    drillEvidencePath: drill.evidencePath,
    liveEraseReceiptPath: liveErase.receipt!.path,
    originalMain: await git(cloneRoot, ["rev-parse", "refs/heads/main"]),
    originalAuxiliary: await git(cloneRoot, ["rev-parse", "refs/heads/auxiliary"]),
    originalRemoteMain: await git(cloneRoot, ["rev-parse", "refs/remotes/origin/main"]),
    originalRemoteAuxiliary: await git(cloneRoot, ["rev-parse", "refs/remotes/origin/auxiliary"]),
    backupArchiveSha256: await sha256File(backup.archivePath),
  };
}

async function writeAt(root: string, relPath: string, content: string): Promise<void> {
  const path = join(root, ...relPath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
