import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDiskFree } from "../../../../src/cli/commands/verify/disk-free.js";

describe("storage.disk-free verify check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-disk-free-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    [20, "pass"],
    [9, "warn"],
    [4, "fail"],
  ] as const)("reports %s%% free as %s", async (freePercent, status) => {
    const result = await checkDiskFree(
      { vaultRoot: root, now: () => new Date("2026-08-04T00:00:00.000Z") },
      async () => ({ blocks: 100, bavail: freePercent }),
    );

    expect(result).toMatchObject({
      id: "storage.disk-free",
      status,
    });
    expect(result.detail).toContain(`${freePercent.toFixed(1)}%`);
  });

  it("degrades to n/a when fs.statfs is unavailable", async () => {
    const result = await checkDiskFree(
      { vaultRoot: root, now: () => new Date("2026-08-04T00:00:00.000Z") },
      null,
    );

    expect(result).toMatchObject({
      id: "storage.disk-free",
      status: "skip",
      detail: "n/a: fs.statfs unavailable",
    });
  });
});
