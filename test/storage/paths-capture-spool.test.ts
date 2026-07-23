import { afterEach, describe, expect, it } from "vitest";
import * as paths from "../../src/storage/paths.js";

describe("capture spool state path", () => {
  const original = process.env["MEMORY_CAPTURE_SPOOL_DIR"];

  afterEach(() => {
    if (original === undefined) delete process.env["MEMORY_CAPTURE_SPOOL_DIR"];
    else process.env["MEMORY_CAPTURE_SPOOL_DIR"] = original;
  });

  it("uses the explicit installation-state override outside canonical content", () => {
    process.env["MEMORY_CAPTURE_SPOOL_DIR"] = "C:/install-state/memory-fort/capture-spool";

    expect(paths.captureSpoolDir).toBeTypeOf("function");
    expect(paths.captureSpoolDir()).toBe("C:/install-state/memory-fort/capture-spool");
  });
});
