import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTailErrors } from "../../../src/cli/commands/tail-errors.js";

describe("runTailErrors", () => {
  let tmp: string;
  let origMem: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "tail-"));
    origMem = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = tmp;
  });

  afterEach(async () => {
    if (origMem === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMem;
    await rm(tmp, { recursive: true, force: true });
  });

  it("emits existing log content on initial read", async () => {
    await writeFile(join(tmp, "errors.log"), "first\nsecond\n");
    let captured = "";
    const result = await runTailErrors({
      exitAfterInitial: true,
      stdout: (text) => {
        captured += text;
      },
    });
    expect(captured).toBe("first\nsecond\n");
    expect(result.bytesEmitted).toBe(13);
  });

  it("emits empty string for empty log", async () => {
    await writeFile(join(tmp, "errors.log"), "");
    let captured = "";
    const result = await runTailErrors({
      exitAfterInitial: true,
      stdout: (text) => {
        captured += text;
      },
    });
    expect(captured).toBe("");
    expect(result.bytesEmitted).toBe(0);
  });

  it("emits error to stderr when log file is missing", async () => {
    let stderrCapture = "";
    const result = await runTailErrors({
      exitAfterInitial: true,
      stdout: () => {},
      stderr: (text) => {
        stderrCapture += text;
      },
    });
    expect(result.bytesEmitted).toBe(0);
    expect(stderrCapture).toContain("not found");
  });
});
