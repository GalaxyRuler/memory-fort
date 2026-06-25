import { describe, expect, it, vi } from "vitest";
import { createAutoHealScheduler } from "../../src/dashboard/auto-heal-scheduler.js";
import { createFullCorpusAdmissionGate } from "../../src/dashboard/full-corpus-admission.js";

describe("auto-heal scheduler", () => {
  it("skips a tick while search holds the full-corpus gate", async () => {
    const gate = createFullCorpusAdmissionGate();
    let releaseSearch!: () => void;
    const search = gate.runSearch(async () => {
      await new Promise<void>((resolve) => {
        releaseSearch = resolve;
      });
    });
    await until(() => gate.snapshot().active?.kind === "search");

    let handler!: () => void;
    const runTick = vi.fn(async () => ({
      embedded: 0,
      skippedExisting: 0,
      skippedBudget: 0,
      skippedPending: 0,
      errors: [],
    }));

    createAutoHealScheduler({
      vaultRoot: "/vault",
      config: { auto_heal: { enabled: true, tick_interval_seconds: 1 } },
      runTick,
      setIntervalFn: ((callback: () => void) => {
        handler = callback;
        return Symbol("interval") as unknown as NodeJS.Timeout;
      }) as typeof setInterval,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
      fullCorpusGate: gate,
    });

    handler();
    await Promise.resolve();

    expect(runTick).not.toHaveBeenCalled();
    releaseSearch();
    await search;
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
