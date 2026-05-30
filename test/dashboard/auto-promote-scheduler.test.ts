import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoPromoteScheduler,
  runAutoPromoteOnce,
  runScheduledVaultTasksOnce,
} from "../../src/dashboard/auto-promote-scheduler.js";

describe("auto-promote scheduler", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-promote-scheduler-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("does not register an interval when disabled or manual", async () => {
    const intervalFactory = vi.fn();
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: false, cadence: "weekly" }, compile: { scheduled: false } }),
      intervalFactory,
    });
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "manual" }, compile: { scheduled: false } }),
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

    expect(intervalFactory).toHaveBeenCalledWith(expect.any(Function), 7 * 24 * 60 * 60 * 1000);
    intervalFactory.mock.calls[0]![0]();
    expect(runner).toHaveBeenCalledOnce();
    scheduler.close();
    expect(clearIntervalFactory).toHaveBeenCalledWith(handle);
  });

  it("does not register scheduled compile by default", async () => {
    const intervalFactory = vi.fn();
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({}),
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

    expect(intervalFactory).toHaveBeenCalledWith(expect.any(Function), 24 * 60 * 60 * 1000);
    intervalFactory.mock.calls[0]![0]();
    expect(compileRunner).toHaveBeenCalledOnce();
    scheduler.close();
    expect(clearIntervalFactory).toHaveBeenCalledWith(handle);
  });

  it("passes compile.execute to scheduled compile runners", async () => {
    const handle = Symbol("interval") as unknown as NodeJS.Timeout;
    const intervalFactory = vi.fn(() => handle);
    const compileRunner = vi.fn(async () => ({
      rawFilesIncluded: [],
      rawFilesSkipped: [],
      outputPath: "state/scheduled-compile-prompt.md",
      rawRemaining: 0,
    }));
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ compile: { scheduled: true, cadence: "daily", execute: true } }),
      intervalFactory,
      compileRunner,
    });

    intervalFactory.mock.calls[0]![0]();

    expect(compileRunner).toHaveBeenCalledWith({ execute: true });
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

  it("logs scheduler failures without throwing", async () => {
    await mkdir(tmp, { recursive: true });
    await runAutoPromoteOnce(tmp);

    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain("auto-promote scheduler failed:");
  });
});
