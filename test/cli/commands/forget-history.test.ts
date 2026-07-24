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
import { dirname, join, relative } from "node:path";
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
  HistoryPurgeEvidencePendingError,
  HistoryPurgePartialError,
  runHistoryPurge,
} from "../../../src/forget/history-purge.js";
import { collectSelectedContentFingerprints } from "../../../src/forget/content-fingerprints.js";
import {
  signEvidencePayload,
  createEvidenceSigner,
  verifyEvidenceSignature,
} from "../../../src/forget/evidence-auth.js";
import { atomicWrite } from "../../../src/storage/atomic-write.js";

const execFileAsync = promisify(execFile);
const FORGOTTEN_RAW = "raw/2026-07-23/codex-selected.md";
const FORGOTTEN_MARKER = "SYNTHETIC-FORGOTTEN-MARKER-7E2A";
const RETAINED_MARKER = "SYNTHETIC-RETAINED-MARKER-91C4";
const COPIED_PATH = "wiki/notes/copied-marker.md";
const COPIED_RETAINED_MARKER = "SYNTHETIC-COPIED-RETAINED-5B18";
const SHARED_GENERIC_LINE = "source: codex";
const BODY_COLLIDES_WITH_FRONTMATTER = "category: synthetic";
const LOW_SPECIFICITY_RAW = "raw/2026-07-23/codex-low-specificity.md";
const SHARED_GENERIC_BODY_LINES = ["Done", "Notes", "2026"] as const;
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
  readonly evidenceSecurityDir: string;
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
    await expect(runHistoryPurge(base)).rejects.toThrow(/live erase receipt.*signature/i);
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
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*signature/i);

    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      completedAt: "2026-07-01T00:00:00.000Z",
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*signature/i);

    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      repository: {
        ...evidence.repository,
        fingerprint: "sha256:mismatched-repository",
      },
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*signature/i);

    await writeFile(fixture.drillEvidencePath, `${JSON.stringify({
      ...evidence,
      repository: {
        ...evidence.repository,
        refs: {
          ...evidence.repository.refs,
          heads: {
            ...evidence.repository.refs.heads,
            "refs/heads/auxiliary": fixture.originalMain,
          },
        },
      },
    }, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*signature/i);

    const unsignedEvidence = JSON.parse(originalEvidence) as Record<string, unknown>;
    delete unsignedEvidence["auth"];
    await writeFile(fixture.drillEvidencePath, `${JSON.stringify(unsignedEvidence, null, 2)}\n`);
    await expect(runHistoryPurge(base)).rejects.toThrow(/restore drill evidence.*signature.*missing/i);

    await writeFile(fixture.drillEvidencePath, originalEvidence);
    await expect(runHistoryPurge({
      ...base,
      rawPaths: ["raw/2026-07-23/codex-other.md"],
    })).rejects.toThrow(/exact live erase selection/i);

    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"])).toBe(originalMain);

    await rm(join(fixture.evidenceSecurityDir, "evidence-hmac-v1.key"), { force: true });
    await expect(runHistoryPurge(base)).rejects.toThrow(/evidence.*key.*missing/i);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"])).toBe(originalMain);
  });

  it("blocks before rewrite when the deterministic fingerprint safety ceiling is exceeded", async () => {
    const capPath = "raw/2026-07-23/fingerprint-cap.md";
    await writeAt(fixture.cloneRoot, capPath, [
      "SYNTHETIC-FINGERPRINT-CAP-MARKER-ALPHA-7E2A",
      "",
      "SYNTHETIC-FINGERPRINT-CAP-MARKER-BETA-91C4",
      "",
    ].join("\n"));
    const fingerprints = await collectSelectedContentFingerprints(
      fixture.cloneRoot,
      [capPath],
      1,
    );
    expect(fingerprints).toMatchObject({
      coverageComplete: false,
      coverageReason: "fingerprint-limit-exceeded",
      count: 1,
      totalCount: 2,
      maxCount: 1,
    });

    const originalMain = await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"]);
    const signedReceipt = JSON.parse(await readFile(fixture.liveEraseReceiptPath, "utf8")) as {
      auth: unknown;
      selection: Record<string, unknown>;
      [key: string]: unknown;
    };
    const { auth: _auth, ...payload } = signedReceipt;
    payload.selection = { ...payload.selection, contentFingerprints: fingerprints };
    const resigned = await signEvidencePayload(payload, fixture.evidenceSecurityDir);
    await writeFile(fixture.liveEraseReceiptPath, `${JSON.stringify(resigned, null, 2)}\n`);

    await expect(runHistoryPurge(purgeOptions(fixture))).rejects.toThrow(/fingerprint coverage is incomplete/i);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"])).toBe(originalMain);
  });

  it("blocks purge planning when selected content has no sufficiently specific units", async () => {
    const lowSpecificityErase = await runForget({
      mode: "apply",
      rawPaths: [LOW_SPECIFICITY_RAW],
      now: new Date("2026-07-24T10:12:00.000Z"),
      evidenceSecurityDir: fixture.evidenceSecurityDir,
    });
    expect(lowSpecificityErase.receipt?.path).toBeTruthy();
    const receipt = JSON.parse(await readFile(lowSpecificityErase.receipt!.path, "utf8")) as {
      selection: {
        contentFingerprints: {
          coverageComplete: boolean;
          coverageReason?: string;
          count: number;
        };
      };
    };
    expect(receipt.selection.contentFingerprints).toMatchObject({
      coverageComplete: false,
      coverageReason: "no-sufficiently-specific-units",
      count: 0,
    });

    const originalMain = await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"]);
    await expect(runHistoryPurge({
      ...purgeOptions(fixture),
      rawPaths: [LOW_SPECIFICITY_RAW],
      liveEraseReceiptPath: lowSpecificityErase.receipt!.path,
    })).rejects.toThrow(/no-sufficiently-specific-units.*no history rewrite/i);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"])).toBe(originalMain);
  });

  it("requires the exact consequence phrase and a clean, separate disposable clone", async () => {
    const base = purgeOptions(fixture);
    const planned = await runHistoryPurge(base);
    expect(planned.status).toBe("planned");
    expect(planned.report).toContain(`Required confirmation: ${PURGE_HISTORY_CONFIRMATION}`);
    expect(planned.report).toContain(`- ${FORGOTTEN_RAW}`);
    expect(planned.report).toContain(`- ${COPIED_PATH}`);
    expect(planned.report).toContain("- refs/heads/main");
    expect(planned.report).toContain("- refs/heads/auxiliary");
    expect(planned.report).toMatch(/same device.*evidence key/i);

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

    const unchangedHead = await git(fixture.cloneRoot, ["rev-parse", "HEAD"]);
    await git(fixture.cloneRoot, ["branch", "-f", "auxiliary", "main"]);
    await expect(runHistoryPurge(base)).rejects.toThrow(/refs\/heads\/auxiliary.*evidence/i);
    expect(await git(fixture.cloneRoot, ["rev-parse", "HEAD"])).toBe(unchangedHead);
    expect(await git(fixture.cloneRoot, ["rev-parse", "refs/heads/main"]))
      .toBe(fixture.originalMain);
    await git(fixture.cloneRoot, ["branch", "-f", "auxiliary", fixture.originalAuxiliary]);

    await expect(runHistoryPurge({
      ...base,
      repositoryRoot: fixture.canonicalRoot,
      confirmation: PURGE_HISTORY_CONFIRMATION,
    })).rejects.toThrow(/canonical repository/i);
  });

  it("surfaces a verified external journal and resumes after final signing fails post-update", async () => {
    const before = new Map([
      ["refs/heads/main", fixture.originalMain],
      ["refs/heads/auxiliary", fixture.originalAuxiliary],
    ]);
    let injected = false;
    let failure: unknown;
    try {
      await runHistoryPurge({
        ...purgeOptions(fixture),
        confirmation: PURGE_HISTORY_CONFIRMATION,
        evidenceSignerFactory: async (securityDir) => {
          const signer = await createEvidenceSigner(securityDir);
          return {
            keyId: signer.keyId,
            sign: async (payload) => {
              if (!injected && payload.kind === "memory-fort-history-purge") {
                injected = true;
                throw new Error("injected final purge receipt signing failure");
              }
              return signer.sign(payload);
            },
          };
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HistoryPurgeEvidencePendingError);
    const pending = failure as HistoryPurgeEvidencePendingError;
    expect(pending.message).toContain("injected final purge receipt signing failure");
    expect(pending.recoveryAction).toContain("same command");
    expect("receiptPath" in pending).toBe(false);
    expect(relative(fixture.cloneRoot, pending.journalPath).startsWith(".."))
      .toBe(true);

    const journal = JSON.parse(await readFile(pending.journalPath, "utf8")) as {
      refs: Array<{ name: string; before: string; after: string }>;
    };
    await expect(verifyEvidenceSignature(
      journal,
      fixture.evidenceSecurityDir,
      "history purge prepared journal",
    )).resolves.toBeUndefined();
    for (const ref of journal.refs) {
      expect(before.get(ref.name)).toBe(ref.before);
      expect(await git(fixture.cloneRoot, ["rev-parse", ref.name])).toBe(ref.after);
    }

    const resumed = await runHistoryPurge({
      ...purgeOptions(fixture),
      confirmation: PURGE_HISTORY_CONFIRMATION,
    });
    expect(resumed.status).toBe("purged-local-history/limited-scope");
    expect(resumed.refs).toEqual(journal.refs);
    expect(relative(fixture.cloneRoot, resumed.receiptPath!).startsWith(".."))
      .toBe(true);
  });

  it("fails closed on final receipt write, reports mixed refs, and finalizes only after exact recovery", async () => {
    let failFinalReceipt = true;
    let failure: unknown;
    try {
      await runHistoryPurge({
        ...purgeOptions(fixture),
        confirmation: PURGE_HISTORY_CONFIRMATION,
        evidenceWrite: async (path, content) => {
          const normalized = path.replace(/\\/g, "/");
          if (
            failFinalReceipt
            && normalized.includes("/records/history-purge/")
            && normalized.endsWith("/receipt.json")
          ) {
            failFinalReceipt = false;
            throw new Error("injected final purge receipt write failure");
          }
          await atomicWrite(path, content);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(HistoryPurgeEvidencePendingError);
    const pending = failure as HistoryPurgeEvidencePendingError;
    expect(pending.message).toContain("injected final purge receipt write failure");
    expect("receiptPath" in pending).toBe(false);
    const journal = JSON.parse(await readFile(pending.journalPath, "utf8")) as {
      refs: Array<{ name: string; before: string; after: string }>;
    };
    await expect(verifyEvidenceSignature(
      journal,
      fixture.evidenceSecurityDir,
      "history purge prepared journal",
    )).resolves.toBeUndefined();

    const auxiliary = journal.refs.find((ref) => ref.name === "refs/heads/auxiliary")!;
    const main = journal.refs.find((ref) => ref.name === "refs/heads/main")!;
    await git(fixture.cloneRoot, ["branch", "-f", "auxiliary", auxiliary.before]);

    let mixedFailure: unknown;
    try {
      await runHistoryPurge({
        ...purgeOptions(fixture),
        confirmation: PURGE_HISTORY_CONFIRMATION,
      });
    } catch (error) {
      mixedFailure = error;
    }
    expect(mixedFailure).toBeInstanceOf(HistoryPurgePartialError);
    const partial = mixedFailure as HistoryPurgePartialError;
    expect(relative(fixture.cloneRoot, partial.receiptPath).startsWith(".."))
      .toBe(true);
    const signedPartial = JSON.parse(await readFile(partial.receiptPath, "utf8")) as unknown;
    await expect(verifyEvidenceSignature(
      signedPartial,
      fixture.evidenceSecurityDir,
      "history purge partial receipt",
    )).resolves.toBeUndefined();
    expect(await git(fixture.cloneRoot, ["rev-parse", main.name])).toBe(main.after);
    expect(await git(fixture.cloneRoot, ["rev-parse", auxiliary.name])).toBe(auxiliary.before);

    await git(fixture.cloneRoot, ["branch", "-f", "auxiliary", auxiliary.after]);
    const resumed = await runHistoryPurge({
      ...purgeOptions(fixture),
      confirmation: PURGE_HISTORY_CONFIRMATION,
    });
    expect(resumed.status).toBe("purged-local-history/limited-scope");
    expect(resumed.refs).toEqual(journal.refs);
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
    const copiedBody = await readFile(join(fixture.cloneRoot, ...COPIED_PATH.split("/")), "utf8");
    expect(copiedBody).not.toContain(FORGOTTEN_MARKER);
    expect(copiedBody).toContain(COPIED_RETAINED_MARKER);
    expect(copiedBody).toContain(SHARED_GENERIC_LINE);
    expect(copiedBody).toContain(BODY_COLLIDES_WITH_FRONTMATTER);
    for (const genericLine of SHARED_GENERIC_BODY_LINES) {
      expect(copiedBody).toContain(genericLine);
      expect(await git(fixture.cloneRoot, [
        "log",
        ...SCOPED_REFS,
        "--format=%H",
        "-S",
        genericLine,
        "--",
        COPIED_PATH,
      ])).not.toBe("");
    }
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
    const copiedRetainedHistory = await git(fixture.cloneRoot, [
      "log",
      ...SCOPED_REFS,
      "--format=%H",
      "-S",
      COPIED_RETAINED_MARKER,
    ]);
    expect(copiedRetainedHistory).not.toBe("");

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
      auth: { algorithm: string; keyId: string; signature: string };
      limitations: string[];
      refs: Array<{ name: string; before: string; after: string }>;
      selection: {
        contentFingerprints: {
          algorithm: string;
          coverageComplete: boolean;
          count: number;
          coverageReason: string;
          specificity: Record<string, string | number>;
          hashes: string[];
        };
        additionalAffectedPaths: string[];
      };
      validation: { passed: boolean; commands: Array<{ result: string }> };
      operationEvidencePath: string;
    };
    expect(receipt.status).toBe("purged-local-history/limited-scope");
    expect(receipt.auth).toMatchObject({
      algorithm: "HMAC-SHA256",
      keyId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      signature: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(verifyEvidenceSignature(
      receipt,
      fixture.evidenceSecurityDir,
      "history purge receipt",
    )).resolves.toBeUndefined();
    expect(receipt.refs).toEqual(result.refs);
    expect(receipt.validation.passed).toBe(true);
    expect(receipt.validation.commands.every((command) => command.result === "passed")).toBe(true);
    expect(receipt.selection.contentFingerprints).toMatchObject({
      algorithm: "sha256-normalized-specific-text-v2",
      coverageComplete: true,
      coverageReason: "complete",
      specificity: {
        policy: "specificity-v1",
        lineMinCharacters: 24,
        lineMinTokens: 4,
        entropyTokenMinCharacters: 16,
        entropyTokenMinCharacterClasses: 2,
        entropyTokenMinDistinctAlphanumerics: 10,
        blockMinLines: 2,
        blockMinCharacters: 80,
        blockMinTokens: 12,
      },
    });
    expect(receipt.selection.contentFingerprints.count).toBeGreaterThan(0);
    expect(receipt.selection.contentFingerprints.hashes).toHaveLength(
      receipt.selection.contentFingerprints.count,
    );
    expect(receipt.selection.additionalAffectedPaths).toEqual([COPIED_PATH]);
    expect(receipt.limitations).toEqual(expect.arrayContaining([
      expect.stringMatching(/remote refs and hosted repositories were not updated/i),
      expect.stringMatching(/other clones were not purged/i),
      expect.stringMatching(/reflogs were retained/i),
      expect.stringMatching(/backup archives and manifests were not deleted/i),
      expect.stringMatching(/unreachable objects remain until manual garbage collection/i),
    ]));
    expect(receiptText).not.toContain(FORGOTTEN_MARKER);
    expect(result.report).not.toContain(FORGOTTEN_MARKER);
    expect(receiptText).not.toContain(BODY_COLLIDES_WITH_FRONTMATTER);
    expect(receiptText).not.toContain(COPIED_RETAINED_MARKER);
    expect(receiptText).not.toContain(SHARED_GENERIC_LINE);
    const durableReceiptPath = result.receiptPath!;
    const durableJournalPath = receipt.operationEvidencePath;
    expect(relative(fixture.cloneRoot, durableReceiptPath).startsWith(".."))
      .toBe(true);
    expect(relative(fixture.cloneRoot, durableJournalPath).startsWith(".."))
      .toBe(true);
    const preparedJournal = JSON.parse(await readFile(durableJournalPath, "utf8")) as unknown;
    await expect(verifyEvidenceSignature(
      preparedJournal,
      fixture.evidenceSecurityDir,
      "history purge prepared journal",
    )).resolves.toBeUndefined();

    await rm(fixture.cloneRoot, { recursive: true, force: true });
    const receiptAfterCloneDeletion = JSON.parse(await readFile(durableReceiptPath, "utf8")) as unknown;
    const journalAfterCloneDeletion = JSON.parse(await readFile(durableJournalPath, "utf8")) as unknown;
    await expect(verifyEvidenceSignature(
      receiptAfterCloneDeletion,
      fixture.evidenceSecurityDir,
      "history purge receipt",
    )).resolves.toBeUndefined();
    await expect(verifyEvidenceSignature(
      journalAfterCloneDeletion,
      fixture.evidenceSecurityDir,
      "history purge prepared journal",
    )).resolves.toBeUndefined();
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
    evidenceSecurityDir: fixture.evidenceSecurityDir,
  };
}

async function makePurgeFixture(): Promise<PurgeFixture> {
  const tmp = await mkdtemp(join(tmpdir(), "forget-history-"));
  const canonicalRoot = join(tmp, "canonical");
  const cloneRoot = join(tmp, "disposable-clone");
  const backupRoot = join(tmp, "backups");
  const evidenceSecurityDir = join(tmp, "evidence-security");
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
    BODY_COLLIDES_WITH_FRONTMATTER,
    ...SHARED_GENERIC_BODY_LINES,
    "",
  ].join("\n"));
  await writeAt(
    canonicalRoot,
    LOW_SPECIFICITY_RAW,
    ["---", "source: codex", "---", ...SHARED_GENERIC_BODY_LINES, ""].join("\n"),
  );
  await writeAt(
    canonicalRoot,
    "raw/2026-07-23/codex-other.md",
    `---\nsource: codex-other\n---\n${RETAINED_MARKER}\n`,
  );
  await writeAt(
    canonicalRoot,
    COPIED_PATH,
    `---\n${SHARED_GENERIC_LINE}\n${BODY_COLLIDES_WITH_FRONTMATTER}\n---\n${FORGOTTEN_MARKER}\n${SHARED_GENERIC_BODY_LINES.join("\n")}\n${COPIED_RETAINED_MARKER}\n`,
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
    evidenceSecurityDir,
  });

  process.env["MEMORY_ROOT"] = canonicalRoot;
  process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "live-index.db");
  process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(tmp, "capture-spool");
  const liveErase = await runForget({
    mode: "apply",
    rawPaths: [FORGOTTEN_RAW],
    now: new Date("2026-07-24T10:10:00.000Z"),
    evidenceSecurityDir,
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
    evidenceSecurityDir,
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
