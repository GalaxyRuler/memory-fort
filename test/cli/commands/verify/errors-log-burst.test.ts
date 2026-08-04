import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkErrorsLogBurst } from "../../../../src/cli/commands/verify/errors-log-burst.js";

describe("storage.errors-log-burst verify check", () => {
  let root: string;
  const now = new Date("2026-08-04T12:00:00.000Z");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-errors-log-burst-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("warns above 50 recent non-Warning events while excluding warnings", async () => {
    const lines = [
      "[2026-08-04T11:59:00.000Z] Warning: expected config notice",
      ...Array.from({ length: 51 }, (_, index) =>
        `${new Date(now.getTime() - index * 1000).toISOString()} Error: burst ${index}`),
    ];
    await writeFile(join(root, "errors.log"), `${lines.join("\n")}\n`);

    const result = await checkErrorsLogBurst({ vaultRoot: root, now: () => now });

    expect(result).toMatchObject({
      id: "storage.errors-log-burst",
      status: "warn",
    });
    expect(result.detail).toContain("51 non-Warning");
  });

  it("passes when the recent burst is at or below the threshold", async () => {
    const lines = Array.from({ length: 50 }, (_, index) =>
      `${new Date(now.getTime() - index * 1000).toISOString()} Error: bounded ${index}`);
    await writeFile(join(root, "errors.log"), `${lines.join("\n")}\n`);

    const result = await checkErrorsLogBurst({ vaultRoot: root, now: () => now });

    expect(result).toMatchObject({
      id: "storage.errors-log-burst",
      status: "pass",
    });
    expect(result.detail).toContain("50 non-Warning");
  });

  it("does not count events older than the trailing ten-minute window", async () => {
    const lines = Array.from({ length: 51 }, (_, index) =>
      `${new Date(now.getTime() - 11 * 60 * 1000 - index * 1000).toISOString()} Error: old ${index}`);
    await writeFile(join(root, "errors.log"), `${lines.join("\n")}\n`);

    const result = await checkErrorsLogBurst({ vaultRoot: root, now: () => now });

    expect(result).toMatchObject({
      id: "storage.errors-log-burst",
      status: "pass",
    });
    expect(result.detail).toContain("0 non-Warning");
  });
});
