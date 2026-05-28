import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutoPromoteScheduler,
  runAutoPromoteOnce,
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
      configLoader: async () => ({ auto_promote: { enabled: false, cadence: "weekly" } }),
      intervalFactory,
    });
    await createAutoPromoteScheduler({
      vaultRoot: tmp,
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "manual" } }),
      intervalFactory,
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
      configLoader: async () => ({ auto_promote: { enabled: true, cadence: "weekly" } }),
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

  it("logs scheduler failures without throwing", async () => {
    await mkdir(tmp, { recursive: true });
    await runAutoPromoteOnce(tmp);

    await expect(readFile(join(tmp, "errors.log"), "utf-8")).resolves.toContain("auto-promote scheduler failed:");
  });
});
