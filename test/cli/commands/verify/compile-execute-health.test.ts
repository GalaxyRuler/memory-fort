import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCompileExecuteHealth } from "../../../../src/cli/commands/verify/compile-execute-health.js";
import { writeCompileStateFile } from "../../../../src/compile/state.js";

describe("checkCompileExecuteHealth", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-execute-health-"));
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
    await writeCompileStateFile(tmp, {
      status: "completed",
      lastRun: { execute: true, operationsApplied: 2, operationsProposed: 1 },
    });

    await expect(checkCompileExecuteHealth({ vaultRoot: tmp, now: () => new Date() })).resolves.toMatchObject({
      id: "compile.execute-health",
      status: "pass",
      detail: "compile execute applied 2 operation(s), proposed 1",
    });
  });
});
