import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatAutoHealResult,
  runAutoHealCommand,
} from "../../../src/cli/commands/auto-heal.js";

describe("auto-heal command", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "auto-heal-command-"));
    await mkdir(tmp, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reports disabled status from config defaults", async () => {
    const result = await runAutoHealCommand({
      action: "status",
      memoryRoot: tmp,
      configLoader: async () => ({}),
    });

    expect(result.exitCode).toBe(0);
    expect(formatAutoHealResult(result)).toContain("Enabled: false");
    expect(formatAutoHealResult(result)).toContain("Daily cap: $0.5000");
  });

  it("runs a tick through the auto-heal worker", async () => {
    const tick = vi.fn(async () => ({
      exitCode: 0,
      enabled: true,
      embedded: 1,
      unchanged: 0,
      skippedPending: 0,
      skippedBudget: 0,
      errors: [],
      dailySpendUsd: 0.0001,
      dailyBudgetUsd: 0.5,
      nextReset: "2026-06-05T00:00:00.000Z",
    }));

    const result = await runAutoHealCommand({
      action: "tick",
      memoryRoot: tmp,
      tick,
    });

    expect(tick).toHaveBeenCalledWith({ memoryRoot: tmp });
    expect(formatAutoHealResult(result)).toContain("Embedded: 1");
  });

  it("enable and disable patch config without storing secrets", async () => {
    await writeFile(join(tmp, "config.yaml"), "embedder:\n  provider: voyage\n");
    const applied: Array<Record<string, unknown>> = [];

    await runAutoHealCommand({
      action: "enable",
      memoryRoot: tmp,
      applyConfigPatch: async (_root, patch) => {
        applied.push(patch);
        return { applied: ["auto_heal.enabled"] };
      },
    });
    await runAutoHealCommand({
      action: "disable",
      memoryRoot: tmp,
      applyConfigPatch: async (_root, patch) => {
        applied.push(patch);
        return { applied: ["auto_heal.enabled"] };
      },
    });

    expect(applied).toEqual([
      { auto_heal: { enabled: true } },
      { auto_heal: { enabled: false } },
    ]);
  });
});
