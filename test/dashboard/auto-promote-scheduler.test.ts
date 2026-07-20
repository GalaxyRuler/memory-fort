import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoPromoteScheduler,
  runAutoPromoteOnce,
  runScheduledCompileOnce,
  runScheduledVaultTasksOnce,
} from "../../src/dashboard/auto-promote-scheduler.js";
import { createFullCorpusAdmissionGate } from "../../src/dashboard/full-corpus-admission.js";
import { writeCompileStateFile } from "../../src/compile/state.js";

describe("auto-promote scheduler", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-promote-scheduler-"));
    process.env["MEMORY_SCHEDULER_STATE_PATH"] = join(tmp, "scheduler-state.json");
  });

  afterEach(async () => {
    delete process.env["MEMORY_SCHEDULER_STATE_PATH"];
    // A heartbeat's state-stamp write can still be settling; retry the rmdir.
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const HEARTBEAT_MS = 15 * 60 * 1000;

  async function fireHeartbeat(
    intervalFactory: { mock: { calls: Array<[() => void, number]> } },
    until?: () => boolean,
  ): Promise<void> {
    intervalFactory.mock.calls[0]![0]();
    // The heartbeat chain ends in fsync-backed, lock-guarded state writes —
    // real disk I/O whose latency varies wildly under full-suite load. Poll
    // for the expected condition; fall back to a generous fixed window for
    // negative assertions.
    const deadline = Date.now() + 5000;
    if (until) {
      while (Date.now() < deadline) {
        if (until()) {
          // One extra tick lets the stamp write settle after the runner call.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  it("does not register an interval when disabled or manual", async () => {
    const intervalFactory = vi.fn();
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: false, cadence: "weekly" }, compile: { scheduled: false }, clients: { "claude-desktop": false } }),
      intervalFactory,
    });
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "manual" }, compile: { scheduled: false }, clients: { "claude-desktop": false } }),
      intervalFactory,
    });

    expect(intervalFactory).not.toHaveBeenCalled();
  });

  it("does not register intervals when the vault is read-only", async () => {
    const intervalFactory = vi.fn();
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({
        auto_promote: { enabled: true, cadence: "weekly" },
        compile: { scheduled: true, cadence: "daily", execute: true },
      }),
      intervalFactory,
      writeCapability: {
        writable: false,
        reason: "read-only mirror — run `memory dashboard` on your machine to make changes",
      },
    });

    expect(intervalFactory).not.toHaveBeenCalled();
  });

  it("registers the expected weekly cadence and clears it on close", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const clearIntervalFactory = vi.fn();
    const runner = vi.fn(async () => undefined);
    const scheduler = await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "weekly" }, compile: { scheduled: false } }),
      intervalFactory,
      clearIntervalFactory,
      runner,
    });

    expect(intervalFactory).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_MS);
    await fireHeartbeat(intervalFactory);
    expect(runner).toHaveBeenCalledOnce();
    scheduler.close();
    expect(clearIntervalFactory).toHaveBeenCalledWith(handle);
  });

  it("does not register scheduled compile by default", async () => {
    const intervalFactory = vi.fn();
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ clients: { "claude-desktop": false } }),
      intervalFactory,
      compileRunner: vi.fn(async () => undefined),
    });

    expect(intervalFactory).not.toHaveBeenCalled();
  });

  it("registers scheduled compile only when explicitly enabled", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const clearIntervalFactory = vi.fn();
    const compileRunner = vi.fn(async () => undefined);
    const scheduler = await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ compile: { scheduled: true, cadence: "daily" } }),
      intervalFactory,
      clearIntervalFactory,
      compileRunner,
    });

    expect(intervalFactory).toHaveBeenCalledWith(expect.any(Function), HEARTBEAT_MS);
    await fireHeartbeat(intervalFactory);
    expect(compileRunner).toHaveBeenCalledOnce();
    scheduler.close();
    expect(clearIntervalFactory).toHaveBeenCalledWith(handle);
  });

  it("skips a scheduled compile tick while search holds the full-corpus gate", async () => {
    const gate = createFullCorpusAdmissionGate();
    let releaseSearch!: () => void;
    const search = gate.runSearch(async () => {
      await new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
    });
    await until(() => gate.snapshot().active?.kind === "search");

    const intervalFactory = vi.fn((handler: () => void) => {
      handler();
      return Symbol("interval") as unknown as NodeJS.Timeout;
    });
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "var/compile/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));

    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ compile: { scheduled: true, cadence: "daily" } }),
      intervalFactory,
      compileRunner,
      fullCorpusGate: gate,
    });

    await Promise.resolve();
    expect(compileRunner).not.toHaveBeenCalled();
    releaseSearch();
    await search;
  });

  it("passes compile.execute to scheduled compile runners", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "var/compile/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ compile: { scheduled: true, cadence: "daily", execute: true } }),
      intervalFactory,
      compileRunner,
    });

    await fireHeartbeat(intervalFactory);

    expect(compileRunner).toHaveBeenCalledWith({ execute: true });
  });

  it("passes bounded drain settings to scheduled compile runners when configured", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "var/compile/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({
        compile: {
          scheduled: true,
          cadence: "daily",
          execute: true,
          drain: true,
          max_passes_per_run: 3,
          raw_filter: true,
        },
      }),
      intervalFactory,
      compileRunner,
    });

    await fireHeartbeat(intervalFactory);

    expect(compileRunner).toHaveBeenCalledWith({
      execute: true,
      drain: true,
      maxPasses: 3,
      rawFilter: true,
    });
  });

  it("runs scheduled compile before auto-promote work", async () => {
    const calls: string[] = [];

    await runScheduledVaultTasksOnce(tmp, {
      compileRunner: async () => {
        calls.push("compile");
      },
      autoPromoteRunner: async () => {
        calls.push("auto-promote");
      },
    });

    expect(calls).toEqual(["compile", "auto-promote"]);
  });

  it("logs scheduled compile with already-drained and pending-tail labels", async () => {
    await mkdir(join(tmp, "prompts"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-06-04"), { recursive: true });
    await writeFile(join(tmp, "prompts", "compile.md"), "RAW={{raw_content}}\n");
    await writeFile(join(tmp, "schema.md"), "# Schema\n");
    await writeFile(join(tmp, "index.md"), "# Index\n");
    await writeFile(join(tmp, "log.md"), "# Log\n");
    await writeFile(join(tmp, "raw", "2026-06-04", "pending.md"), "abcdef");
    await writeFile(join(tmp, "raw", "2026-06-04", "drained.md"), "12345");
    await writeCompileStateFile(tmp, {
      consumed: {
        "raw/2026-06-04/pending.md": { bytes: 2 },
        "raw/2026-06-04/drained.md": { bytes: 5 },
      },
    });

    const result = await runScheduledCompileOnce(tmp);

    expect(result.pendingSummary).toMatchObject({
      filesWithPendingTail: 1,
      filesFullyDrained: 1,
    });
    await expect(readFile(join(tmp, "log.md"), "utf-8")).resolves.toMatch(
      /compile \| scheduled prompt: 1 raw included, 1 already-drained, 1 pending tails/,
    );
    await expect(readFile(join(tmp, "log.md"), "utf-8")).resolves.not.toMatch(/raw included, \d+ skipped/);
  });

  it("logs scheduler failures without throwing", async () => {
    await mkdir(tmp, { recursive: true });
    await runAutoPromoteOnce(tmp);

    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain("auto-promote scheduler failed:");
  });

  it("persists last-run across scheduler instances so restarts do not reset the cadence", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const configLoader = async () => ({ auto_promote: { enabled: true, cadence: "daily" }, compile: { scheduled: false } });

    const firstFactory = vi.fn(() => handle);
    const firstRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: tmp, configLoader, intervalFactory: firstFactory, runner: firstRunner });
    await fireHeartbeat(firstFactory, () => firstRunner.mock.calls.length > 0);
    expect(firstRunner).toHaveBeenCalledOnce();

    // Simulate an app restart: brand-new scheduler, same persisted state.
    const secondFactory = vi.fn(() => handle);
    const secondRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: tmp, configLoader, intervalFactory: secondFactory, runner: secondRunner });
    await fireHeartbeat(secondFactory);
    expect(secondRunner).not.toHaveBeenCalled();

    // Once the cadence has elapsed, the task is due again.
    const thirdFactory = vi.fn(() => handle);
    const thirdRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader,
      intervalFactory: thirdFactory,
      runner: thirdRunner,
      now: () => new Date(Date.now() + 25 * 60 * 60 * 1000),
    });
    await fireHeartbeat(thirdFactory, () => thirdRunner.mock.calls.length > 0);
    expect(thirdRunner).toHaveBeenCalledOnce();
  });

  it("runs compile and auto-promote in the same heartbeat when both are due", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "var/compile/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    const autoPromoteRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({
        auto_promote: { enabled: true, cadence: "daily" },
        compile: { scheduled: true, cadence: "daily" },
      }),
      intervalFactory,
      compileRunner,
      autoPromoteRunner,
    });

    await fireHeartbeat(
      intervalFactory,
      () => compileRunner.mock.calls.length > 0 && autoPromoteRunner.mock.calls.length > 0,
    );

    // The old per-task intervals shared one re-entrancy flag, so auto-promote
    // was silently starved whenever compile claimed the tick.
    expect(compileRunner).toHaveBeenCalledOnce();
    expect(autoPromoteRunner).toHaveBeenCalledOnce();
  });

  it("runs the hourly watcher sniff and honors its persisted stamp", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const configLoader = async () => ({ auto_promote: { enabled: false, cadence: "manual" }, compile: { scheduled: false } });

    const firstFactory = vi.fn(() => handle);
    const sniffRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: tmp, configLoader, intervalFactory: firstFactory, sniffRunner });
    await fireHeartbeat(firstFactory, () => sniffRunner.mock.calls.length > 0);
    expect(sniffRunner).toHaveBeenCalledOnce();

    // Within the hour — not due again, even on a fresh scheduler instance.
    const secondFactory = vi.fn(() => handle);
    const secondSniff = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: tmp, configLoader, intervalFactory: secondFactory, sniffRunner: secondSniff });
    await fireHeartbeat(secondFactory);
    expect(secondSniff).not.toHaveBeenCalled();

    // After the hourly cadence elapses it runs again.
    const thirdFactory = vi.fn(() => handle);
    const thirdSniff = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader,
      intervalFactory: thirdFactory,
      sniffRunner: thirdSniff,
      now: () => new Date(Date.now() + 61 * 60 * 1000),
    });
    await fireHeartbeat(thirdFactory, () => thirdSniff.mock.calls.length > 0);
    expect(thirdSniff).toHaveBeenCalledOnce();
  });

  it("does not run the sniff when claude-desktop is disabled in config", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const sniffRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({
        auto_promote: { enabled: false, cadence: "manual" },
        compile: { scheduled: false },
        clients: { "claude-desktop": false },
      }),
      intervalFactory,
      sniffRunner,
    });

    expect(intervalFactory).not.toHaveBeenCalled();
    expect(sniffRunner).not.toHaveBeenCalled();
  });

  it("keys stamps by canonical vault path — spelling variants share one history", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const configLoader = async () => ({ auto_promote: { enabled: true, cadence: "daily" }, compile: { scheduled: false } });

    const firstFactory = vi.fn(() => handle);
    const firstRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: tmp, configLoader, intervalFactory: firstFactory, runner: firstRunner });
    await fireHeartbeat(firstFactory);
    expect(firstRunner).toHaveBeenCalledOnce();

    // Same vault, different spelling (trailing separator + case) — not due.
    const variant = `${tmp.toUpperCase()}\\`;
    const secondFactory = vi.fn(() => handle);
    const secondRunner = vi.fn(async () => undefined);
    await createAutoPromoteScheduler({ vaultRoot: variant, configLoader, intervalFactory: secondFactory, runner: secondRunner });
    await fireHeartbeat(secondFactory);
    expect(secondRunner).not.toHaveBeenCalled();
  });

  it("does not run tasks after close()", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const runner = vi.fn(async () => undefined);
    const scheduler = await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "daily" }, compile: { scheduled: false } }),
      intervalFactory,
      runner,
    });

    scheduler.close();
    await fireHeartbeat(intervalFactory);

    expect(runner).not.toHaveBeenCalled();
  });

  it("does not stamp a gate-busy skip — the task stays due for the next heartbeat", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const runner = vi.fn(async () => undefined);
    const gate = createFullCorpusAdmissionGate();
    // Hold the gate with a long-running search so maintenance is refused.
    let releaseSearch: () => void = () => undefined;
    void gate.runSearch(() => new Promise<void>((resolve) => { releaseSearch = resolve; }));
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "daily" }, compile: { scheduled: false } }),
      intervalFactory,
      runner,
      fullCorpusGate: gate,
    });

    await fireHeartbeat(intervalFactory);
    expect(runner).not.toHaveBeenCalled();

    releaseSearch();
    await fireHeartbeat(intervalFactory);
    expect(runner).toHaveBeenCalledOnce();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
