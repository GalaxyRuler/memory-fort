import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCompileExecuteHealth } from "../../../../src/cli/commands/verify/compile-execute-health.js";

describe("checkCompileExecuteHealth", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-execute-health-"));
    await mkdir(join(tmp, "state"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when no execute run has been requested yet", async () => {
    await expect(checkCompileExecuteHealth({ vaultRoot: tmp, now: () => new Date() })).resolves.toMatchObject({
      id: "compile.execute-health",
      status: "pass",
      detail: "no executed compile run recorded",
    });
  });

  it("passes when the last compile execute run recorded operation counts", async () => {
    await writeFile(join(tmp, "state", "compile-state.json"), JSON.stringify({
      status: "completed",
      lastRun: { execute: true, operationsApplied: 2, operationsProposed: 1 },
    }));

    await expect(checkCompileExecuteHealth({ vaultRoot: tmp, now: () => new Date() })).resolves.toMatchObject({
      id: "compile.execute-health",
      status: "pass",
      detail: "compile execute applied 2 operation(s), proposed 1",
    });
  });
});
