import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const forgetRmFailure = vi.hoisted(() => ({
  target: null as string | null,
  pauseTarget: null as string | null,
  pauseStarted: null as (() => void) | null,
  pauseRelease: null as Promise<void> | null,
  unlinkTarget: null as string | null,
  renameTarget: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const normalized = String(args[0]).replace(/\\/g, "/");
      const pauseTarget = forgetRmFailure.pauseTarget;
      if (pauseTarget && normalized.endsWith(pauseTarget)) {
        forgetRmFailure.pauseTarget = null;
        forgetRmFailure.pauseStarted?.();
        await forgetRmFailure.pauseRelease;
      }
      const target = forgetRmFailure.target;
      if (target && normalized.endsWith(target)) {
        throw new Error(`injected remove failure: ${target}`);
      }
      return actual.rm(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const target = forgetRmFailure.unlinkTarget;
      if (target && String(args[0]).replace(/\\/g, "/").endsWith(target)) {
        throw new Error(`injected unlink failure: ${target}`);
      }
      return actual.unlink(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const target = forgetRmFailure.renameTarget;
      if (target && String(args[1]).replace(/\\/g, "/") === target.replace(/\\/g, "/")) {
        throw new Error(`injected rename failure: ${target}`);
      }
      return actual.rename(...args);
    },
  };
});

import {
  ForgetPartialMutationError,
  LiveEraseEvidencePendingError,
  resolveDirectRawSelectors,
  runForget,
} from "../../../src/cli/commands/forget.js";
import { runReindex } from "../../../src/cli/commands/reindex.js";
import { openIndexDb, openReadOnlyIndexDb } from "../../../src/index/db.js";
import { lexicalSearch } from "../../../src/index/search.js";
import { reconcileIndex } from "../../../src/index/reconcile.js";
import { readIndexGeneration } from "../../../src/index/generation.js";
import { loadSearchCorpus } from "../../../src/retrieval/corpus.js";
import { confidenceAwareIndex } from "../../../src/hooks/session-start-helpers.js";
import {
  appendBlock,
  ensureRawCaptureEpoch,
  ensureRawSessionFile,
  getCaptureSpoolStatus,
  rawCaptureEpochPath,
} from "../../../src/hooks/raw-file.js";
import { withFileLock } from "../../../src/storage/file-lock.js";
import { readLiveEraseReceipt } from "../../../src/forget/evidence.js";
import { verifyEvidenceSignature } from "../../../src/forget/evidence-auth.js";
import { atomicWrite } from "../../../src/storage/atomic-write.js";

const execFileAsync = promisify(execFile);

describe("runForget", () => {
  let tmp: string;
  let root: string;
  let previousMemoryRoot: string | undefined;
  let previousIndexPath: string | undefined;
  let previousSpoolDir: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "forget-"));
    root = join(tmp, ".memory");
    previousMemoryRoot = process.env["MEMORY_ROOT"];
    previousIndexPath = process.env["MEMORY_INDEX_DB_PATH"];
    previousSpoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    process.env["MEMORY_ROOT"] = root;
    process.env["MEMORY_INDEX_DB_PATH"] = join(tmp, "index.db");
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = join(tmp, "capture-spool");
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    forgetRmFailure.target = null;
    forgetRmFailure.pauseTarget = null;
    forgetRmFailure.pauseStarted = null;
    forgetRmFailure.pauseRelease = null;
    forgetRmFailure.unlinkTarget = null;
    forgetRmFailure.renameTarget = null;
    if (previousMemoryRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = previousMemoryRoot;
    if (previousIndexPath === undefined) delete process.env["MEMORY_INDEX_DB_PATH"];
    else process.env["MEMORY_INDEX_DB_PATH"] = previousIndexPath;
    if (previousSpoolDir === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = previousSpoolDir;
    await rm(tmp, { recursive: true, force: true });
  });

  it("defaults to a non-mutating provenance plan for a canonical raw selector", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await writeAt("raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md", "archived session");
    await writeAt("crystals/keep.md", "retained crystal");
    await writeAt("backups/backup-manifest.json", "{}\n");
    await rebuildFixtureIndex();

    const result = await runForget({ rawPaths: [raw] });

    expect(result.mode).toBe("plan");
    expect(result.plan.raw).toEqual([raw]);
    expect(result.plan.facts).toEqual(["facts/2026-05-20/session.json"]);
    expect(result.plan.generated).toEqual(["wiki/projects/generated.md"]);
    expect(result.plan.relations).toEqual(["wiki/projects/generated.md"]);
    expect(result.plan.index.fts).toEqual([raw, "wiki/projects/generated.md"]);
    expect(result.plan.history.status).toBe("history-retained");
    expect(result.report).toContain("history-retained");
    expect(result.report).toContain("Planned live raw paths: 1\n- raw/2026-05-20/codex-session.md");
    expect(result.report).toContain("Planned derived fact files to delete: 1\n- facts/2026-05-20/session.json");
    expect(result.report).toContain("Planned generated pages to delete: 1\n- wiki/projects/generated.md");
    expect(result.report).toContain("Planned provenance relations to remove: 1\n- wiki/projects/generated.md");
    expect(result.report).toContain("Preserved archived copies: 1\n- raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md");
    expect(result.report).toContain("Preserved crystals: 1\n- crystals/keep.md");
    expect(result.report).toContain("Preserved vault-local backup manifests: 1\n- backups/backup-manifest.json");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
  });

  it("erases only live attributable material, rebuilds the derived index, and never removes archived copies", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await writeAt("wiki/archive/2026-05-21/raw/2026-05-20/codex-session.md", "archived secret");
    await writeAt("wiki/archive/2026-05-22/raw/2026-05-20/codex-session.md", "duplicate archived secret");
    await writeAt("wiki/.archive/2026-05-23/raw/2026-05-20/codex-session.md", "canonical archived secret");
    await writeAt("raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md", "compacted archived secret");
    await writeAt("raw/2026-05-20/codex-other.md", "same-size-sessio");
    await writeWiki(
      "projects/retained.md",
      { type: "projects", title: "Retained", confidence: 0.9 },
      "Fresh retained project context.",
    );
    await writeAt(
      "index.md",
      "- [Generated](wiki/projects/generated.md) - STALE-FORGOTTEN-SUMMARY\n",
    );
    await rebuildFixtureIndex();

    const result = await runForget({ mode: "apply", rawPaths: [raw] });

    expect(result.status).toBe("live-erased/history-retained");
    expect(result.plan.archive).toEqual([
      "raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md",
      "wiki/.archive/2026-05-23/raw/2026-05-20/codex-session.md",
      "wiki/archive/2026-05-21/raw/2026-05-20/codex-session.md",
      "wiki/archive/2026-05-22/raw/2026-05-20/codex-session.md",
    ]);
    expect(result.erased).toEqual(expect.arrayContaining([
      raw,
      "facts/2026-05-20/session.json",
      "wiki/projects/generated.md",
    ]));
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, "facts", "2026-05-20", "session.json"))).toBe(false);
    expect(existsSync(join(root, "wiki", "projects", "generated.md"))).toBe(false);
    expect(await readFile(join(root, "wiki", "archive", "2026-05-21", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("archived secret");
    expect(await readFile(join(root, "wiki", "archive", "2026-05-22", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("duplicate archived secret");
    expect(await readFile(join(root, "wiki", ".archive", "2026-05-23", "raw", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("canonical archived secret");
    expect(await readFile(join(root, "raw", ".compact-archive", "2026-05-24", "2026-05-20", "codex-session.md"), "utf8"))
      .toContain("compacted archived secret");
    const corpus = await loadSearchCorpus({ vaultRoot: root, scope: "all" });
    expect(corpus.documents.map((document) => document.relPath)).not.toEqual(expect.arrayContaining([
      raw,
      "wiki/projects/generated.md",
    ]));
    expect(corpus.documents.map((document) => document.relPath)).toContain("raw/2026-05-20/codex-other.md");
    expect(readIndexGeneration(root).state).toBe("ready");
    const rebuiltIndex = await readFile(join(root, "index.md"), "utf8");
    expect(rebuiltIndex).toContain("[Retained](wiki/projects/retained.md) - Fresh retained project context.");
    expect(rebuiltIndex).not.toContain("Generated");
    expect(rebuiltIndex).not.toContain("STALE-FORGOTTEN-SUMMARY");
    const sessionIndex = await confidenceAwareIndex({
      indexFilePath: join(root, "index.md"),
      memoryRoot: root,
    });
    expect(sessionIndex).toContain("wiki/projects/retained.md");
    expect(sessionIndex).not.toContain("STALE-FORGOTTEN-SUMMARY");
    const index = openReadOnlyIndexDb({ vaultRoot: root });
    try {
      expect(index.database.prepare<[string], { count: number }>("SELECT count(*) AS count FROM chunks WHERE relPath = ?").get(raw)?.count)
        .toBe(0);
    } finally {
      index.close();
    }
  });

  it("prepares signed external evidence before Git mutation and resumes final receipt persistence", async () => {
    const signerRaw = "raw/2026-05-20/signer-readiness.md";
    const pendingRaw = "raw/2026-05-20/receipt-pending.md";
    const signerMarker = "SYNTHETIC-SIGNER-READINESS-PRIVATE-MARKER";
    const pendingMarker = "SYNTHETIC-RECEIPT-PENDING-PRIVATE-MARKER";
    const evidenceSecurityDir = join(tmp, "evidence-security");
    await writeAt(signerRaw, `${signerMarker}\n`);
    await writeAt(pendingRaw, `${pendingMarker}\n`);
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "memory-fort-tests@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Memory Fort Tests"], { cwd: root });
    await execFileAsync("git", ["add", signerRaw, pendingRaw], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "seed synthetic forget evidence fixture"], { cwd: root });
    await rebuildFixtureIndex();

    await expect(runForget({
      mode: "apply",
      rawPaths: [signerRaw],
      evidenceSecurityDir,
      evidenceSignerFactory: async () => {
        throw new Error("injected signer readiness failure");
      },
    })).rejects.toThrow("injected signer readiness failure");
    expect(existsSync(join(root, ...signerRaw.split("/")))).toBe(true);

    let failFinalReceipt = true;
    let failure: unknown;
    try {
      await runForget({
        mode: "apply",
        rawPaths: [pendingRaw],
        evidenceSecurityDir,
        evidenceWrite: async (path, content) => {
          const normalized = path.replace(/\\/g, "/");
          if (
            failFinalReceipt
            && normalized.includes("/records/live-erase/")
            && normalized.endsWith("/receipt.json")
          ) {
            failFinalReceipt = false;
            throw new Error("injected final receipt write failure");
          }
          await atomicWrite(path, content);
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LiveEraseEvidencePendingError);
    const pending = failure as LiveEraseEvidencePendingError;
    expect(pending.message).toContain("injected final receipt write failure");
    expect(pending.recoveryAction).toContain("forget --apply");
    expect(pending.journalPath).toContain(join("records", "live-erase"));
    expect(relative(root, pending.journalPath).startsWith(".."))
      .toBe(true);
    expect(existsSync(join(root, ...pendingRaw.split("/")))).toBe(false);

    const signedJournal = JSON.parse(await readFile(pending.journalPath, "utf8")) as unknown;
    await expect(verifyEvidenceSignature(
      signedJournal,
      evidenceSecurityDir,
      "live erase prepared journal",
    )).resolves.toBeUndefined();
    expect(await readFile(pending.journalPath, "utf8")).not.toContain(pendingMarker);

    const resumed = await runForget({
      mode: "apply",
      rawPaths: [pendingRaw],
      evidenceSecurityDir,
    });
    expect(resumed.status).toBe("live-erased/history-retained");
    expect(resumed.receipt?.path).toContain(join("records", "live-erase"));
    expect(relative(root, resumed.receipt!.path).startsWith(".."))
      .toBe(true);
    await expect(readLiveEraseReceipt(resumed.receipt!.path, evidenceSecurityDir))
      .resolves.toMatchObject({ status: "live-erased/history-retained" });
  });

  it("restarts an exact prepared live erase after pre-delete invalidation recovery", async () => {
    const raw = "raw/2026-05-20/prepared-restart.md";
    const evidenceSecurityDir = join(tmp, "evidence-security");
    await seedAttributableRaw(raw);
    await writeAt("index.md", "STALE-PREPARED-RESTART-CONTEXT\n");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "memory-fort-tests@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Memory Fort Tests"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "seed prepared restart fixture"], { cwd: root });
    await rebuildFixtureIndex();
    forgetRmFailure.target = "/index.md";

    await expect(runForget({
      mode: "apply",
      rawPaths: [raw],
      evidenceSecurityDir,
    })).rejects.toBeInstanceOf(ForgetPartialMutationError);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
    expect(readIndexGeneration(root).state).toBe("invalidating");

    forgetRmFailure.target = null;
    await expect(runReindex({ vaultRoot: root })).resolves.toMatchObject({ path: "index.md" });
    expect(readIndexGeneration(root).state).toBe("ready");

    const resumed = await runForget({
      mode: "apply",
      rawPaths: [raw],
      evidenceSecurityDir,
    });
    expect(resumed.status).toBe("live-erased/history-retained");
    expect(resumed.erased).toEqual(expect.arrayContaining([
      raw,
      "facts/2026-05-20/session.json",
      "wiki/projects/generated.md",
    ]));
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    await expect(readLiveEraseReceipt(resumed.receipt!.path, evidenceSecurityDir))
      .resolves.toMatchObject({ status: "live-erased/history-retained" });
  });

  it("serializes concurrent applies from fresh planning through ready publication", async () => {
    const firstRaw = "raw/2026-05-20/codex-first.md";
    const secondRaw = "raw/2026-05-20/codex-second.md";
    await writeAt(firstRaw, "first sensitive session");
    await writeAt(secondRaw, "second sensitive session");
    await writeAt("index.md", "STALE-CONCURRENT-DERIVED-CONTEXT\n");
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      forgetRmFailure.pauseStarted = resolve;
    });
    forgetRmFailure.pauseRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    forgetRmFailure.pauseTarget = firstRaw;

    const firstApply = runForget({ mode: "apply", rawPaths: [firstRaw] });
    await firstPaused;
    expect(readIndexGeneration(root).state).toBe("invalidating");

    const secondApply = runForget({ mode: "apply", rawPaths: [secondRaw] });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const secondStillPresentWhileFirstPaused = existsSync(join(root, ...secondRaw.split("/")));

    releaseFirst();
    await expect(firstApply).resolves.toMatchObject({ status: "live-erased/history-retained" });
    const secondStillPresentAfterFirstReady = existsSync(join(root, ...secondRaw.split("/")));
    const generationAfterFirst = readIndexGeneration(root).state;

    await expect(secondApply).resolves.toMatchObject({ status: "live-erased/history-retained" });
    expect(secondStillPresentWhileFirstPaused).toBe(true);
    expect(secondStillPresentAfterFirstReady).toBe(true);
    expect(generationAfterFirst).toBe("ready");
    expect(existsSync(join(root, ...secondRaw.split("/")))).toBe(false);
    expect(readIndexGeneration(root).state).toBe("ready");
    await expect(readFile(join(root, "index.md"), "utf-8"))
      .resolves.not.toContain("STALE-CONCURRENT-DERIVED-CONTEXT");
  });

  it("recovers a forget-apply unique claim only when the existing holder is stale and dead", async () => {
    const raw = "raw/2026-05-20/codex-stale-lock.md";
    const lockPath = join(root, "var", "forget-apply.lock");
    const claimPath = join(lockPath, "dead-forget-owner.json");
    await writeAt(raw, "stale lock recovery fixture");
    await mkdir(lockPath, { recursive: true });
    await writeFile(claimPath, JSON.stringify({
      version: 2,
      pid: 2 ** 30,
      host: hostname(),
      ownerToken: "dead-forget-owner",
      acquiredAt: "2020-01-01T00:00:00.000Z",
      choosing: false,
      ticket: 1,
    }));
    const stale = new Date("2020-01-01T00:00:00.000Z");
    await utimes(claimPath, stale, stale);

    await expect(runForget({ mode: "apply", rawPaths: [raw] }))
      .resolves.toMatchObject({ status: "live-erased/history-retained" });
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
  });

  it("removes only attributable queued captures and preserves unrelated legacy recovery evidence", async () => {
    const selected = "raw/2026-05-20/codex-selected-spool.md";
    const unrelated = "raw/2026-05-20/codex-unrelated-spool.md";
    const selectedPath = join(root, ...selected.split("/"));
    const unrelatedPath = join(root, ...unrelated.split("/"));
    const spoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"]!;
    const selectedEventPath = join(spoolDir, "selected-event.json");
    const unrelatedEventPath = join(spoolDir, "unrelated-event.json");
    await writeAt(selected, "selected live raw");
    await writeAt(unrelated, "unrelated live raw");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(selectedEventPath, JSON.stringify({
      version: 1,
      id: "selected-spool-event",
      hash: "selected-spool-hash",
      rawPath: selectedPath,
      block: "SELECTED-SPOOL-BLOCK-MUST-BE-FORGOTTEN",
      createdAt: "2026-05-20T00:00:00.000Z",
    }));
    await writeFile(unrelatedEventPath, JSON.stringify({
      version: 1,
      id: "unrelated-spool-event",
      hash: "unrelated-spool-hash",
      rawPath: unrelatedPath,
      block: "UNRELATED-SPOOL-BLOCK-MUST-SURVIVE",
      createdAt: "2026-05-20T00:00:01.000Z",
    }));

    const planned = await runForget({ rawPaths: [selected] });
    expect(planned.plan.captureSpool).toEqual({
      status: "pending-attributable",
      attributableEventCount: 1,
      pendingEventCount: 1,
      removedEventCount: 0,
      paths: [selectedEventPath],
      pendingPaths: [selectedEventPath],
      removedPaths: [],
    });
    expect(planned.report).toContain(`Attributable capture-spool events: 1\n- ${selectedEventPath}`);
    expect(planned.report).not.toContain("SELECTED-SPOOL-BLOCK-MUST-BE-FORGOTTEN");

    const applied = await runForget({ mode: "apply", rawPaths: [selected] });
    expect(applied.plan.captureSpool).toEqual({
      status: "removed-attributable",
      attributableEventCount: 1,
      pendingEventCount: 0,
      removedEventCount: 1,
      paths: [selectedEventPath],
      pendingPaths: [],
      removedPaths: [selectedEventPath],
    });
    expect((await readdir(spoolDir)).filter((name) => name.endsWith(".json")))
      .toEqual(["unrelated-event.json"]);

    await ensureRawSessionFile({
      tool: "manual",
      sessionId: "replay-trigger",
      cwd: "C:/work",
      now: new Date("2026-05-20T00:00:02.000Z"),
      vaultRoot: root,
    });
    await appendBlock({
      tool: "manual",
      sessionId: "replay-trigger",
      block: "replay trigger",
      now: new Date("2026-05-20T00:00:02.000Z"),
      vaultRoot: root,
    });
    expect(existsSync(selectedPath)).toBe(false);
    await expect(readFile(unrelatedPath, "utf-8"))
      .resolves.not.toContain("UNRELATED-SPOOL-BLOCK-MUST-SURVIVE");
    expect(existsSync(unrelatedEventPath)).toBe(true);
    await expect(getCaptureSpoolStatus()).resolves.toMatchObject({
      pendingEventCount: 1,
      drainFailures: 1,
    });
  });

  it("aborts before live deletion and stays quiesced when spool coordination fails", async () => {
    const selected = "raw/2026-05-20/codex-spool-failure.md";
    const selectedPath = join(root, ...selected.split("/"));
    const spoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"]!;
    const eventPath = join(spoolDir, "blocked-event.json");
    await writeAt(selected, "selected raw must remain after spool failure");
    await writeAt("index.md", "STALE-SPOOL-FAILURE-CONTEXT\n");
    await mkdir(spoolDir, { recursive: true });
    await writeFile(eventPath, JSON.stringify({
      version: 1,
      id: "blocked-spool-event",
      hash: "blocked-spool-hash",
      rawPath: selectedPath,
      block: "blocked queued capture",
      createdAt: "2026-05-20T00:00:00.000Z",
    }));
    forgetRmFailure.unlinkTarget = "blocked-event.json";

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [selected] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "aborted-before-live-mutation/index-invalidating",
      erased: [],
      rewritten: [],
      failed: { operation: "spool", path: eventPath },
      plan: {
        captureSpool: {
          status: "partial-removed-attributable",
          attributableEventCount: 1,
          pendingEventCount: 1,
          removedEventCount: 0,
          pendingPaths: [eventPath],
          removedPaths: [],
          failedPath: eventPath,
        },
      },
    });
    expect(receipt.report).toContain("Status: aborted-before-live-mutation/index-invalidating");
    expect(existsSync(selectedPath)).toBe(true);
    expect(existsSync(eventPath)).toBe(true);
    expect(existsSync(join(root, "index.md"))).toBe(false);
    expect(readIndexGeneration(root).state).toBe("invalidating");
  });

  it("leaves the generation quiesced when invalidation setup fails after derived mutation begins", async () => {
    const raw = "raw/2026-05-20/codex-invalidation-setup.md";
    await seedAttributableRaw(raw);
    await writeAt("index.md", "STALE-SETUP-FAILURE-CONTEXT\n");
    await rebuildFixtureIndex();
    forgetRmFailure.target = "/index.md";

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [raw] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "aborted-before-live-mutation/index-invalidating",
      erased: [],
      rewritten: [],
      failed: { operation: "invalidation", path: "derived-index" },
    });
    expect(receipt.report).toContain("Failed invalidation: derived-index");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
    expect(existsSync(process.env["MEMORY_INDEX_DB_PATH"]!)).toBe(false);
    expect(readIndexGeneration(root).state).toBe("invalidating");
    await expect(confidenceAwareIndex({
      indexFilePath: join(root, "index.md"),
      memoryRoot: root,
    })).resolves.toBe("");
  });

  it("reports exact partial spool removal when the second attributable unlink fails", async () => {
    const selected = "raw/2026-05-20/codex-partial-spool.md";
    const selectedPath = join(root, ...selected.split("/"));
    const spoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"]!;
    const firstEventPath = join(spoolDir, "01-first-event.json");
    const secondEventPath = join(spoolDir, "02-second-event.json");
    await writeAt(selected, "selected raw remains on partial spool removal");
    await mkdir(spoolDir, { recursive: true });
    for (const [path, id] of [[firstEventPath, "first"], [secondEventPath, "second"]] as const) {
      await writeFile(path, JSON.stringify({
        version: 1,
        id: `${id}-event`,
        hash: `${id}-hash`,
        rawPath: selectedPath,
        block: `${id} private block`,
        createdAt: "2026-05-20T00:00:00.000Z",
      }));
    }
    forgetRmFailure.unlinkTarget = "02-second-event.json";

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [selected] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "aborted-before-live-mutation/index-invalidating",
      erased: [],
      rewritten: [],
      failed: { operation: "spool", path: secondEventPath },
      plan: {
        captureSpool: {
          status: "partial-removed-attributable",
          attributableEventCount: 2,
          pendingEventCount: 1,
          removedEventCount: 1,
          paths: [firstEventPath, secondEventPath],
          pendingPaths: [secondEventPath],
          removedPaths: [firstEventPath],
          failedPath: secondEventPath,
          epochInvalidation: {
            status: "not-started",
            advancedRawPaths: [],
            quarantinedRawPaths: [],
            pendingRawPaths: [selectedPath],
          },
        },
      },
    });
    expect(receipt.report).toContain(`Removed attributable capture-spool events: 1\n- ${firstEventPath}`);
    expect(receipt.report).toContain(`Failed spool: ${secondEventPath}`);
    expect(receipt.report).toContain("Capture epoch invalidation status: not-started");
    expect(receipt.report).not.toContain("first private block");
    expect(receipt.report).not.toContain("second private block");
    expect(existsSync(firstEventPath)).toBe(false);
    expect(existsSync(secondEventPath)).toBe(true);
    expect(existsSync(selectedPath)).toBe(true);
    expect(readIndexGeneration(root).state).toBe("invalidating");
  });

  it("reports removed spool entries and partial epoch quarantine when a later epoch write fails", async () => {
    const firstRaw = "raw/2026-05-20/01-epoch-advanced.md";
    const secondRaw = "raw/2026-05-20/02-epoch-fails.md";
    const firstRawPath = join(root, ...firstRaw.split("/"));
    const secondRawPath = join(root, ...secondRaw.split("/"));
    const firstEpochPath = rawCaptureEpochPath(firstRawPath);
    const secondEpochPath = rawCaptureEpochPath(secondRawPath);
    const spoolDir = process.env["MEMORY_CAPTURE_SPOOL_DIR"]!;
    const firstEventPath = join(spoolDir, "01-epoch-event.json");
    const secondEventPath = join(spoolDir, "02-epoch-event.json");
    await writeAt(firstRaw, "first raw remains after epoch setup failure\n");
    await writeAt(secondRaw, "second raw remains after epoch setup failure\n");
    await ensureRawCaptureEpoch(firstRawPath);
    await ensureRawCaptureEpoch(secondRawPath);
    await writeAt("index.md", "STALE-EPOCH-SETUP-CONTEXT\n");
    await mkdir(spoolDir, { recursive: true });
    for (const [path, id, rawPath] of [
      [firstEventPath, "first", firstRawPath],
      [secondEventPath, "second", secondRawPath],
    ] as const) {
      await writeFile(path, JSON.stringify({
        version: 1,
        id: `${id}-epoch-event`,
        hash: `${id}-epoch-hash`,
        rawPath,
        block: `${id} epoch-private block`,
        createdAt: "2026-05-20T00:00:00.000Z",
      }));
    }
    forgetRmFailure.renameTarget = secondEpochPath;

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [firstRaw, secondRaw] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "aborted-before-live-mutation/index-invalidating",
      erased: [],
      rewritten: [],
      failed: { operation: "epoch-invalidation", path: secondEpochPath },
      plan: {
        captureSpool: {
          status: "removed-attributable",
          attributableEventCount: 2,
          pendingEventCount: 0,
          removedEventCount: 2,
          paths: [firstEventPath, secondEventPath],
          pendingPaths: [],
          removedPaths: [firstEventPath, secondEventPath],
          failedPath: secondEpochPath,
          epochInvalidation: {
            status: "partial-invalidating",
            advancedRawPaths: [firstRawPath],
            quarantinedRawPaths: [firstRawPath],
            pendingRawPaths: [secondRawPath],
          },
        },
      },
    });
    expect(receipt.report).toContain("Capture epoch invalidation status: partial-invalidating");
    expect(receipt.report).toContain(`Epoch-invalidating raw paths: 1\n- ${firstRawPath}`);
    expect(receipt.report).toContain(`Epoch transitions not completed: 1\n- ${secondRawPath}`);
    expect(receipt.report).not.toContain("first epoch-private block");
    expect(receipt.report).not.toContain("second epoch-private block");
    expect(existsSync(firstEventPath)).toBe(false);
    expect(existsSync(secondEventPath)).toBe(false);
    expect(existsSync(firstRawPath)).toBe(true);
    expect(existsSync(secondRawPath)).toBe(true);
    expect(JSON.parse(await readFile(firstEpochPath, "utf-8"))).toMatchObject({ state: "invalidating" });
    expect(JSON.parse(await readFile(secondEpochPath, "utf-8"))).toMatchObject({ state: "ready" });
    expect(existsSync(join(root, "index.md"))).toBe(false);
    expect(readIndexGeneration(root).state).toBe("invalidating");
  });

  it("drops a capture that starts while forget holds the selected raw lock", async () => {
    const now = new Date("2026-05-20T00:00:00.000Z");
    const raw = "raw/2026-05-20/codex-epoch-direct.md";
    const rawPath = join(root, ...raw.split("/"));
    await writeAt(raw, "selected live raw\n");
    let releaseForget!: () => void;
    const forgetPaused = new Promise<void>((resolve) => { forgetRmFailure.pauseStarted = resolve; });
    forgetRmFailure.pauseRelease = new Promise<void>((resolve) => { releaseForget = resolve; });
    forgetRmFailure.pauseTarget = raw;

    const forgetting = runForget({ mode: "apply", rawPaths: [raw] });
    await forgetPaused;
    const lateCapture = appendBlock({
      tool: "codex",
      sessionId: "epoch-direct",
      block: "CAPTURE-STARTED-DURING-FORGET",
      now,
      vaultRoot: root,
    });
    await new Promise((resolve) => setTimeout(resolve, 125));
    releaseForget();

    await expect(forgetting).resolves.toMatchObject({ status: "live-erased/history-retained" });
    await expect(lateCapture).resolves.toBeUndefined();
    expect(existsSync(rawPath)).toBe(false);
    expect(existsSync(`${rawPath}.capture-epoch`)).toBe(false);
  });

  it("cannot replay a timed-out pre-forget capture but allows a genuine post-forget capture", async () => {
    const now = new Date("2026-05-20T00:00:00.000Z");
    const raw = "raw/2026-05-20/codex-epoch-spool.md";
    const rawPath = join(root, ...raw.split("/"));
    await writeAt(raw, "selected live raw\n");
    let releaseForget!: () => void;
    const forgetPaused = new Promise<void>((resolve) => { forgetRmFailure.pauseStarted = resolve; });
    forgetRmFailure.pauseRelease = new Promise<void>((resolve) => { releaseForget = resolve; });
    forgetRmFailure.pauseTarget = raw;

    const forgetting = runForget({ mode: "apply", rawPaths: [raw] });
    await forgetPaused;
    const timedOutCapture = appendBlock({
      tool: "codex",
      sessionId: "epoch-spool",
      block: "STALE-TIMED-OUT-CAPTURE",
      now,
      vaultRoot: root,
      lockOptions: { timeoutMs: 30, staleMs: 60_000, pollMs: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 175));
    releaseForget();

    await expect(forgetting).resolves.toMatchObject({ status: "live-erased/history-retained" });
    await expect(timedOutCapture).resolves.toBeUndefined();
    expect(existsSync(rawPath)).toBe(false);
    expect((await readdir(process.env["MEMORY_CAPTURE_SPOOL_DIR"]!)).filter((name) => name.endsWith(".json")))
      .toHaveLength(1);

    await ensureRawSessionFile({
      tool: "codex",
      sessionId: "epoch-spool",
      cwd: "C:/post-forget",
      now: new Date("2026-05-20T00:00:01.000Z"),
      vaultRoot: root,
    });
    await appendBlock({
      tool: "codex",
      sessionId: "epoch-spool",
      block: "FRESH-POST-FORGET-CAPTURE",
      now: new Date("2026-05-20T00:00:01.000Z"),
      vaultRoot: root,
    });

    const content = await readFile(rawPath, "utf-8");
    expect(content).toContain("FRESH-POST-FORGET-CAPTURE");
    expect(content).not.toContain("STALE-TIMED-OUT-CAPTURE");
    expect((await readdir(process.env["MEMORY_CAPTURE_SPOOL_DIR"]!)).filter((name) => name.endsWith(".json")))
      .toEqual([]);
    expect(existsSync(`${rawPath}.capture-epoch`)).toBe(false);
  });

  it("waits for an active compile and replans its derived output before erasing", async () => {
    const raw = "raw/2026-05-20/codex-compile-before-forget.md";
    const derivative = "wiki/projects/compile-before-forget.md";
    await writeAt(raw, "compile source must be forgotten\n");
    let releaseCompile!: () => void;
    let compileStarted!: () => void;
    const started = new Promise<void>((resolve) => { compileStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCompile = resolve; });
    const compile = withFileLock(join(root, "var", "compile", "execute"), async () => {
      compileStarted();
      await release;
      await writeWiki("projects/compile-before-forget.md", {
        type: "projects",
        title: "Compile race derivative",
        generated: true,
        source_facts: [raw],
        relations: { derived_from: [raw] },
      }, "late compile derivative");
    });
    await started;
    let forgetSettled = false;
    const forgetting = runForget({ mode: "apply", rawPaths: [raw] })
      .finally(() => { forgetSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(forgetSettled).toBe(false);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
    releaseCompile();
    await compile;
    const result = await forgetting;

    expect(result.erased).toEqual(expect.arrayContaining([raw, derivative]));
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...derivative.split("/")))).toBe(false);
  });

  it("holds the compile execute lock until forget is ready and prevents late provenance publication", async () => {
    const raw = "raw/2026-05-20/codex-compile-after-forget.md";
    const derivative = "wiki/projects/compile-after-forget.md";
    await writeAt(raw, "compile source must be forgotten\n");
    let releaseForget!: () => void;
    const forgetPaused = new Promise<void>((resolve) => { forgetRmFailure.pauseStarted = resolve; });
    forgetRmFailure.pauseRelease = new Promise<void>((resolve) => { releaseForget = resolve; });
    forgetRmFailure.pauseTarget = raw;

    const forgetting = runForget({ mode: "apply", rawPaths: [raw] });
    await forgetPaused;
    let compileEntered = false;
    let generationAtCompile: string | null = null;
    const compile = withFileLock(join(root, "var", "compile", "execute"), async () => {
      compileEntered = true;
      generationAtCompile = readIndexGeneration(root).state;
      if (existsSync(join(root, ...raw.split("/")))) {
        await writeWiki("projects/compile-after-forget.md", {
          type: "projects",
          title: "Late compile derivative",
          generated: true,
          source_facts: [raw],
          relations: { derived_from: [raw] },
        }, "must not publish after forget");
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(compileEntered).toBe(false);
    releaseForget();
    await expect(forgetting).resolves.toMatchObject({ status: "live-erased/history-retained" });
    await compile;

    expect(compileEntered).toBe(true);
    expect(generationAtCompile).toBe("ready");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...derivative.split("/")))).toBe(false);
  });

  it("keeps reindex behind an active forget and lets it rebuild only after forget publishes ready", async () => {
    const raw = "raw/2026-05-20/codex-reindex-during-forget.md";
    await writeAt(raw, "forget owns the recovery boundary\n");
    await writeWiki(
      "projects/reindex-retained.md",
      { type: "projects", title: "Reindex retained" },
      "retained after serialized recovery",
    );
    let releaseForget!: () => void;
    const forgetPaused = new Promise<void>((resolve) => { forgetRmFailure.pauseStarted = resolve; });
    forgetRmFailure.pauseRelease = new Promise<void>((resolve) => { releaseForget = resolve; });
    forgetRmFailure.pauseTarget = raw;

    const forgetting = runForget({ mode: "apply", rawPaths: [raw] });
    await forgetPaused;
    let reindexSettled = false;
    const reindexing = runReindex({ vaultRoot: root })
      .finally(() => { reindexSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(reindexSettled).toBe(false);
    expect(readIndexGeneration(root).state).toBe("invalidating");
    releaseForget();
    await expect(forgetting).resolves.toMatchObject({ status: "live-erased/history-retained" });
    await expect(reindexing).resolves.toMatchObject({ entries: 1, path: "index.md" });

    expect(readIndexGeneration(root).state).toBe("ready");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    await expect(readFile(join(root, "index.md"), "utf-8"))
      .resolves.toContain("wiki/projects/reindex-retained.md");
  });

  it("returns a truthful partial-mutation receipt and keeps search quiesced when a live erase fails", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    const failedFact = "facts/2026-05-20/session.json";
    await seedAttributableRaw(raw);
    await writeAt(
      "index.md",
      "- [Generated](wiki/projects/generated.md) - STALE-FORGOTTEN-SUMMARY\n",
    );
    await rebuildFixtureIndex();
    forgetRmFailure.target = failedFact;

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [raw] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "partial-live-mutation/rebuild-incomplete",
      erased: [raw],
      rewritten: [],
      failed: { operation: "delete", path: failedFact },
    });
    expect(receipt.report).toContain("Completed live deletions: 1\n- raw/2026-05-20/codex-session.md");
    expect(receipt.report).toContain(`Failed delete: ${failedFact}`);
    expect(readIndexGeneration(root).state).toBe("invalidating");
    expect(existsSync(process.env["MEMORY_INDEX_DB_PATH"]!)).toBe(false);
    expect(existsSync(join(root, "index.md"))).toBe(false);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...failedFact.split("/")))).toBe(true);
    expect(existsSync(join(root, "wiki", "projects", "generated.md"))).toBe(true);
  });

  it("blocks an ambiguous manually curated page rather than erasing a mixed page", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await writeAt(raw, "sensitive session");
    await writeWiki(
      "projects/manual.md",
      {
        type: "projects",
        title: "Manual",
        source_facts: [raw],
        relations: { derived_from: [raw] },
      },
      "A human-curated conclusion that cannot safely be attributed block-by-block.",
    );

    const plan = await runForget({ rawPaths: [raw] });
    expect(plan.plan.blocked).toEqual(["wiki/projects/manual.md"]);
    expect(plan.report).toContain("Blocked manual curated pages: 1\n- wiki/projects/manual.md");
    await expect(runForget({ mode: "apply", rawPaths: [raw] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, ...raw.split("/")))).toBe(true);
  });

  it("itemizes and erases legacy and normalized thread/procedure derivatives", async () => {
    const raw = "raw/2026-05-20/codex-family-lineage.md";
    await writeAt(raw, "---\nsource: codex\n---\n\nfamily lineage source\n");
    const derivatives: Array<[string, Record<string, unknown>]> = [
      ["threads-proposed/legacy-thread-draft.md", {
        type: "threads",
        title: "Legacy thread draft",
        source: "auto-thread-propose",
        relations: { mentions: [raw] },
      }],
      ["threads/legacy-thread.md", {
        type: "threads",
        title: "Legacy thread",
        source: "auto-thread-propose-validated",
        relations: { mentions: [raw] },
      }],
      ["procedures-proposed/legacy-procedure-draft.md", {
        type: "procedures",
        title: "Legacy procedure draft",
        source: "auto-procedural-extract",
        relations: { derived_from: [raw] },
      }],
      ["procedures/legacy-procedure.md", {
        type: "procedures",
        title: "Legacy procedure",
        source: "auto-procedural-extract-validated",
        relations: { derived_from: [raw] },
      }],
      ["threads-proposed/normalized-thread-draft.md", {
        type: "threads",
        title: "Normalized thread draft",
        source: "auto-thread-propose",
        generated: true,
        generated_by: "memory-fort",
        source_facts: [raw],
        relations: { mentions: [raw], derived_from: [raw] },
      }],
      ["threads/normalized-thread.md", {
        type: "threads",
        title: "Normalized thread",
        source: "auto-thread-propose-validated",
        generated: true,
        generated_by: "memory-fort",
        source_facts: [raw],
        relations: { mentions: [raw], derived_from: [raw] },
      }],
      ["procedures-proposed/normalized-procedure-draft.md", {
        type: "procedures",
        title: "Normalized procedure draft",
        source: "auto-procedural-extract",
        generated: true,
        generated_by: "memory-fort",
        source_facts: [raw],
        relations: { derived_from: [raw] },
      }],
      ["procedures/normalized-procedure.md", {
        type: "procedures",
        title: "Normalized procedure",
        source: "auto-procedural-extract-validated",
        generated: true,
        generated_by: "memory-fort",
        source_facts: [raw],
        relations: { derived_from: [raw] },
      }],
    ];
    for (const [path, frontmatter] of derivatives) {
      await writeWiki(path, frontmatter, `Generated derivative ${path}.`);
    }

    const expected = derivatives.map(([path]) => `wiki/${path}`).sort();
    const plan = await runForget({ rawPaths: [raw] });

    expect(plan.plan.generated).toEqual(expected);
    expect(plan.plan.relations).toEqual(expected);
    expect(plan.plan.blocked).toEqual([]);
    const applied = await runForget({ mode: "apply", rawPaths: [raw] });
    expect(applied.erased).toEqual(expect.arrayContaining([raw, ...expected]));
    for (const relPath of [raw, ...expected]) {
      expect(existsSync(join(root, ...relPath.split("/"))), relPath).toBe(false);
    }
  });

  it("supports Unicode and space-bearing canonical paths and source IDs without treating crystals as erasable", async () => {
    const raw = "raw/2026-05-20/codex-session with ünicode.md";
    await writeAt(raw, "sensitive session");
    await writeAt("crystals/keep.md", "crystal references sensitive session");

    const plan = await runForget({ sourceIds: ["codex"] });

    expect(plan.plan.raw).toContain(raw);
    expect(plan.plan.crystals).toEqual(["crystals/keep.md"]);
    expect(plan.plan.erasedCrystals).toEqual([]);
    await expect(runForget({ rawPaths: ["raw/2026-05-20/../codex-session.md"] }))
      .rejects.toThrow("canonical vault-relative path");
    await expect(runForget({ paths: ["crystals/keep.md"] }))
      .rejects.toThrow("crystals are excluded");
  });

  it("maps a case-insensitive direct raw selector to the unique canonical live spelling", async () => {
    const actualRaw = "raw/2026-05-20/Codex-Session.md";
    const selector = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(actualRaw);

    const plan = await runForget({ rawPaths: [selector] });
    const applied = await runForget({ mode: "apply", rawPaths: [selector] });

    expect(plan.plan.raw).toEqual([actualRaw]);
    expect(applied.erased).toEqual(expect.arrayContaining([
      actualRaw,
      "facts/2026-05-20/session.json",
      "wiki/projects/generated.md",
    ]));
    expect(existsSync(join(root, ...actualRaw.split("/")))).toBe(false);
  });

  it("blocks a Windows-equivalent raw selector when live spellings are case-ambiguous", async () => {
    const upper = "raw/2026-05-20/Codex.md";
    const lower = "raw/2026-05-20/codex.md";

    expect(() => resolveDirectRawSelectors(
      ["raw/2026-05-20/CODEX.md"],
      [upper, lower],
    )).toThrow("case-insensitive raw selector is ambiguous");
  });

  it("keeps compact raw archive copies out of source-selected live data and rejects them as direct raw selectors", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    const compactArchive = "raw/.compact-archive/2026-05-24/2026-05-20/codex-session.md";
    const dotArchive = "raw/.retained.md";
    const caseArchive = "raw/Archive/2026-05-24/codex-session.md";
    const maintenanceArchive = "wiki/_archive/retained.md";
    await writeAt(raw, "---\nsource: codex\n---\n\nlive sensitive session\n");
    await writeAt(compactArchive, "---\nsource: codex\n---\n\nretained compact archive\n");
    await writeAt(dotArchive, "---\nsource: codex\n---\n\nretained dot archive\n");
    await writeAt(caseArchive, "---\nsource: codex\n---\n\nretained case archive\n");
    await writeAt(maintenanceArchive, "retained maintenance archive\n");

    const plan = await runForget({ sourceIds: ["codex"] });
    expect(plan.plan.raw).toEqual([raw]);
    expect(plan.plan.archive).toEqual([compactArchive, dotArchive, caseArchive]);

    const applied = await runForget({ mode: "apply", sourceIds: ["codex"] });
    expect(applied.erased).toEqual([raw]);
    expect(existsSync(join(root, ...raw.split("/")))).toBe(false);
    expect(existsSync(join(root, ...compactArchive.split("/")))).toBe(true);
    expect(existsSync(join(root, ...dotArchive.split("/")))).toBe(true);
    expect(existsSync(join(root, ...caseArchive.split("/")))).toBe(true);
    for (const archivedPath of ["raw/.compact-archive", compactArchive, dotArchive, caseArchive]) {
      await expect(runForget({ rawPaths: [archivedPath] }))
        .rejects.toThrow("protected archive or system paths cannot be selected");
      await expect(runForget({ paths: [archivedPath] }))
        .rejects.toThrow("protected archive or system paths cannot be selected");
    }
    for (const protectedWikiPath of ["wiki/Archive/retained.md", "wiki/_archive/retained.md", "wiki/projects/.retained.md"]) {
      await expect(runForget({ paths: [protectedWikiPath] }))
        .rejects.toThrow("protected archive or system paths cannot be selected");
    }
  });

  it("does not over-claim another raw's protected copy for a direct raw selector", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const selectedArchive = "raw/.compact-archive/2026-05-24/2026-05-20/codex-selected.md";
    const unrelatedArchive = "raw/.retained.md";
    await writeAt(selected, "selected sensitive session");
    await writeAt(selectedArchive, "selected retained copy");
    await writeAt(unrelatedArchive, "---\nsource: codex\n---\n\nunrelated retained copy\n");

    const plan = await runForget({ rawPaths: [selected] });

    expect(plan.plan.archive).toEqual([selectedArchive]);
  });

  it("itemizes retained generated-page copies by direct lineage and source-wide lineage", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const sourceOnly = "raw/2026-05-19/codex-source-only.md";
    const sourceOnlyArchive = "raw/.compact-archive/2026-05-24/2026-05-19/codex-source-only.md";
    const selectedGeneratedArchive = "wiki/_archive/generated-selected.md";
    const sourceGeneratedArchive = "wiki/Archive/generated-source-only.md";
    await writeAt(selected, "---\nsource: codex\n---\n\nselected live raw\n");
    await writeAt(sourceOnlyArchive, "---\nsource: codex\n---\n\nretained source-only raw\n");
    await writeWiki(
      "_archive/generated-selected.md",
      {
        type: "projects",
        title: "Retained selected generation",
        generated: true,
        source_facts: [selected],
        relations: { derived_from: [selected] },
      },
      "Retained generated page for the direct raw.",
    );
    await writeWiki(
      "Archive/generated-source-only.md",
      {
        type: "projects",
        title: "Retained source generation",
        generated: true,
        source_facts: [sourceOnly],
        relations: { derived_from: [sourceOnly] },
      },
      "Retained generated page for a source-wide archived raw.",
    );
    await writeWiki(
      "_archive/manual-selected.md",
      {
        type: "projects",
        title: "Retained manual page",
        source_facts: [selected],
      },
      "Manual retained page is not claimed as generated output.",
    );

    const direct = await runForget({ rawPaths: [selected] });
    const sourceWide = await runForget({ sourceIds: ["codex"] });

    expect(direct.plan.archive).toEqual([selectedGeneratedArchive]);
    expect(sourceWide.plan.archive).toEqual([
      sourceOnlyArchive,
      sourceGeneratedArchive,
      selectedGeneratedArchive,
    ]);
    expect(direct.report).toContain(`Preserved archived copies: 1\n- ${selectedGeneratedArchive}`);
    expect(sourceWide.report).toContain(`- ${sourceGeneratedArchive}`);
    expect(sourceWide.plan.archive).not.toContain("wiki/_archive/manual-selected.md");
  });

  it("keeps case-variant archive copies unmutated and out of the rebuilt default index", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    const rawArchive = "raw/Archive/2026-05-24/codex-archive.md";
    const wikiArchive = "wiki/Archive/2026-05-24/raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await writeAt(rawArchive, "---\nsource: codex\n---\n\ncase raw archive token\n");
    await writeAt(wikiArchive, "case wiki archive token\n");
    await rebuildFixtureIndex();

    const result = await runForget({ mode: "apply", sourceIds: ["codex"] });

    expect(result.plan.archive).toEqual([rawArchive, wikiArchive]);
    await expect(readFile(join(root, ...rawArchive.split("/")), "utf8")).resolves.toContain("case raw archive token");
    await expect(readFile(join(root, ...wikiArchive.split("/")), "utf8")).resolves.toContain("case wiki archive token");
    const index = openReadOnlyIndexDb({ vaultRoot: root });
    try {
      expect(lexicalSearch(index, "case raw archive token")).toEqual([]);
      expect(lexicalSearch(index, "case wiki archive token")).toEqual([]);
    } finally {
      index.close();
    }
  });

  it("keeps archived fact copies inventory-only for whole and partial lineage matches", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    const wholeArchive = "facts/Archive/2026-05-24/selected.json";
    const mixedArchive = "facts/.archive/2026-05-24/mixed.json";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeAt(wholeArchive, JSON.stringify([{ sourceRawPath: selected, narrative: "archived selected" }]));
    await writeAt(mixedArchive, JSON.stringify({
      facts: [
        { sourceRawPath: selected, narrative: "archived selected" },
        { sourceRawPath: retained, narrative: "archived retained" },
      ],
    }));

    const result = await runForget({ mode: "apply", rawPaths: [selected] });

    expect(result.plan.archive).toEqual([mixedArchive, wholeArchive]);
    expect(result.erased).not.toEqual(expect.arrayContaining([wholeArchive, mixedArchive]));
    expect(result.rewritten).not.toEqual(expect.arrayContaining([wholeArchive, mixedArchive]));
    await expect(readFile(join(root, ...wholeArchive.split("/")), "utf8")).resolves.toContain(selected);
    await expect(readFile(join(root, ...mixedArchive.split("/")), "utf8")).resolves.toContain(selected);
    await expect(readFile(join(root, ...mixedArchive.split("/")), "utf8")).resolves.toContain(retained);
  });

  it("rejects an apply with no live source match instead of rebuilding or reporting erased data", async () => {
    await expect(runForget({ mode: "apply", sourceIds: ["unknown-source"] }))
      .rejects.toThrow("no live data matched selectors");
    expect(existsSync(process.env["MEMORY_INDEX_DB_PATH"]!)).toBe(false);
  });

  it("returns a truthful partial receipt when the deterministic rebuild fixture fails after live mutations", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await seedAttributableRaw(raw);
    await writeWiki(
      "projects/retained.md",
      { type: "projects", title: "Retained recovery page" },
      "recovery-search-marker remains available",
    );
    await rebuildFixtureIndex();
    const indexPath = process.env["MEMORY_INDEX_DB_PATH"]!;
    const rawPath = join(root, ...raw.split("/"));
    const epochPath = rawCaptureEpochPath(rawPath);
    await ensureRawCaptureEpoch(rawPath);
    expect(existsSync(indexPath)).toBe(true);
    await writeAt(
      "index.md",
      "- [Generated](wiki/projects/generated.md) - STALE-FORGOTTEN-SUMMARY\n",
    );
    await writeAt("wiki/projects/malformed.md", "---\ntitle: [\n---\n\nmalformed\n");

    let failure: unknown;
    try {
      await runForget({ mode: "apply", rawPaths: [raw] });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ForgetPartialMutationError);
    const receipt = (failure as ForgetPartialMutationError).receipt;
    expect(receipt).toMatchObject({
      status: "partial-live-mutation/rebuild-incomplete",
      erased: expect.arrayContaining([
        raw,
        "facts/2026-05-20/session.json",
        "wiki/projects/generated.md",
      ]),
      rewritten: [],
      failed: { operation: "rebuild", path: "derived-index" },
    });
    expect(receipt.report).toContain("Status: partial-live-mutation/rebuild-incomplete");
    expect(receipt.report).toContain("Failed rebuild: derived-index");
    expect(receipt.report).toContain("Fix the reported cause, then run `memory reindex`.");
    expect((failure as Error).message).toContain("partial live mutation");
    expect((failure as Error).message).toContain("Completed live deletions: 3");

    expect(existsSync(rawPath)).toBe(false);
    expect(existsSync(indexPath)).toBe(false);
    expect(existsSync(join(root, "index.md"))).toBe(false);
    const failedGeneration = readIndexGeneration(root);
    expect(failedGeneration.state).toBe("invalidating");
    const failedEpoch = JSON.parse(await readFile(epochPath, "utf-8")) as {
      state: string;
      token: string;
    };
    expect(failedEpoch.state).toBe("invalidating");
    const recoveryPath = join(root, "var", "forget-recovery.json");
    const recoveryMetadata = await readFile(recoveryPath, "utf-8");
    expect(recoveryMetadata).toContain(failedGeneration.token);
    expect(recoveryMetadata).toContain(failedEpoch.token);
    expect(recoveryMetadata).not.toContain("Generated only from the selected raw session.");

    await expect(runReindex({ vaultRoot: root })).rejects.toThrow();
    expect(readIndexGeneration(root)).toEqual(failedGeneration);
    expect(JSON.parse(await readFile(epochPath, "utf-8"))).toEqual(failedEpoch);
    expect(existsSync(indexPath)).toBe(false);
    expect(existsSync(join(root, "index.md"))).toBe(false);

    await rm(join(root, "wiki", "projects", "malformed.md"));
    await expect(runReindex({ vaultRoot: root })).resolves.toMatchObject({
      path: "index.md",
      entries: 1,
    });

    expect(readIndexGeneration(root).state).toBe("ready");
    expect(JSON.parse(await readFile(epochPath, "utf-8"))).toMatchObject({ state: "ready" });
    expect(existsSync(recoveryPath)).toBe(false);
    expect(existsSync(indexPath)).toBe(true);
    await expect(readFile(join(root, "index.md"), "utf-8"))
      .resolves.toContain("wiki/projects/retained.md");
    const search = openReadOnlyIndexDb({ vaultRoot: root });
    try {
      expect(lexicalSearch(search, "recovery search marker").map((result) => result.relPath))
        .toContain("wiki/projects/retained.md");
      expect(lexicalSearch(search, "Generated only from the selected raw session."))
        .toEqual([]);
    } finally {
      search.close();
    }
    await expect(confidenceAwareIndex({
      memoryRoot: root,
      indexFilePath: join(root, "index.md"),
    })).resolves.toContain("wiki/projects/retained.md");

    const now = new Date("2026-05-20T12:00:00.000Z");
    await expect(ensureRawSessionFile({
      tool: "codex",
      sessionId: "session",
      cwd: "C:/recovered",
      now,
    })).resolves.toBe(rawPath);
    await appendBlock({
      tool: "codex",
      sessionId: "session",
      block: "\n## [12:00:00] Prompt\n\ncapture-after-recovery\n",
      now,
    });
    await expect(readFile(rawPath, "utf-8")).resolves.toContain("capture-after-recovery");
  });

  it("blocks a generated page with multi-lineage instead of deleting its unrelated source material", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeWiki(
      "projects/shared.md",
      {
        type: "projects",
        title: "Shared lineage",
        generated: true,
        source_facts: [selected, retained],
        relations: { derived_from: [selected, retained] },
      },
      "Generated from two distinct sources.",
    );

    const plan = await runForget({ rawPaths: [selected] });

    expect(plan.plan.blocked).toEqual(["wiki/projects/shared.md"]);
    await expect(runForget({ mode: "apply", rawPaths: [selected] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, ...selected.split("/")))).toBe(true);
    expect(existsSync(join(root, ...retained.split("/")))).toBe(true);
  });

  it("blocks generated pages selected directly or by source when canonical raw lineage is absent", async () => {
    await writeWiki(
      "projects/no-provenance.md",
      { type: "projects", title: "No provenance", generated: true },
      "A generated page with no canonical raw lineage.",
    );
    await writeWiki(
      "projects/broad-source.md",
      { type: "projects", title: "Broad source", generated: true, source: "compile" },
      "A generated page selected only through a broad source label.",
    );

    const direct = await runForget({ paths: ["wiki/projects/no-provenance.md"] });
    const broad = await runForget({ sourceIds: ["compile"] });

    expect(direct.plan.blocked).toEqual(["wiki/projects/no-provenance.md"]);
    expect(broad.plan.blocked).toEqual(["wiki/projects/broad-source.md"]);
    await expect(runForget({ mode: "apply", paths: ["wiki/projects/no-provenance.md"] }))
      .rejects.toThrow("ambiguous manual curated content");
    await expect(runForget({ mode: "apply", sourceIds: ["compile"] }))
      .rejects.toThrow("ambiguous manual curated content");
    expect(existsSync(join(root, "wiki", "projects", "no-provenance.md"))).toBe(true);
    expect(existsSync(join(root, "wiki", "projects", "broad-source.md"))).toBe(true);
  });

  it("does not claim a zero external-backup inventory when the backup target is not recorded", async () => {
    const raw = "raw/2026-05-20/codex-session.md";
    await writeAt(raw, "sensitive session");
    const externalTarget = join(tmp, "external-backups");
    await mkdir(externalTarget, { recursive: true });
    await writeFile(join(externalTarget, "backup-manifest.json"), "{}\n");

    const plan = await runForget({ rawPaths: [raw] });

    expect(plan.plan.history.backupManifests).toEqual([]);
    expect(plan.plan.history.externalBackupDiscovery).toBe("unavailable-or-not-configured");
    expect(plan.report).toContain("External backup discovery: unavailable or not configured");
  });

  it("reports a fact file as partially redacted when unrelated facts remain", async () => {
    const selected = "raw/2026-05-20/codex-selected.md";
    const retained = "raw/2026-05-20/codex-retained.md";
    await writeAt(selected, "selected session");
    await writeAt(retained, "retained session");
    await writeAt(
      "facts/2026-05-20/mixed.json",
      JSON.stringify({
        facts: [
          { sourceRawPath: selected, narrative: "selected" },
          { sourceRawPath: retained, narrative: "retained" },
        ],
      }),
    );

    const plan = await runForget({ rawPaths: [selected] });
    const applied = await runForget({ mode: "apply", rawPaths: [selected] });

    expect(plan.plan.facts).toEqual([]);
    expect(plan.plan.rewrittenFacts).toEqual(["facts/2026-05-20/mixed.json"]);
    expect(applied.erased).not.toContain("facts/2026-05-20/mixed.json");
    expect(applied.rewritten).toEqual(["facts/2026-05-20/mixed.json"]);
    expect(applied.report).toContain("Derived fact files partially redacted: 1");
    expect(applied.report).toContain("Partially redacted fact files retained: facts/2026-05-20/mixed.json");
    await expect(readFile(join(root, "facts", "2026-05-20", "mixed.json"), "utf8"))
      .resolves.toContain(retained);
  });

  async function seedAttributableRaw(raw: string): Promise<void> {
    await writeAt(raw, "sensitive session");
    await writeAt(
      "facts/2026-05-20/session.json",
      JSON.stringify({
        version: 1,
        sourceRawPath: raw,
        sessionId: "session",
        observedAt: "2026-05-20T00:00:00.000Z",
        compressedAt: "2026-05-20T00:00:00.000Z",
        facts: [{
          title: "Sensitive",
          facts: ["sensitive session"],
          narrative: "sensitive session",
          concepts: ["sensitive"],
          files: [],
          importance: 5,
          sessionId: "session",
          sourceRawPath: raw,
          observedAt: "2026-05-20T00:00:00.000Z",
          compressedAt: "2026-05-20T00:00:00.000Z",
        }],
      }, null, 2),
    );
    await writeWiki(
      "projects/generated.md",
      {
        type: "projects",
        title: "Generated",
        generated: true,
        source_facts: [raw],
        relations: { derived_from: [raw] },
      },
      "Generated only from the selected raw session.",
    );
  }

  async function rebuildFixtureIndex(): Promise<void> {
    const index = openIndexDb({ vaultRoot: root });
    try {
      await reconcileIndex(index, root);
    } finally {
      index.close();
    }
  }

  async function writeWiki(relPath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    await writeAt(`wiki/${relPath}`, `---\n${yaml}\n---\n\n${body}\n`);
  }

  async function writeAt(relPath: string, content: string): Promise<void> {
    const full = join(root, ...relPath.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
});
