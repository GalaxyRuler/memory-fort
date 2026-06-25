import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Electron main heap policy", () => {
  it("does not try to raise the already-started main-process heap", async () => {
    const source = await readFile(join(process.cwd(), "electron", "main.ts"), "utf-8");

    expect(source).not.toContain("node:v8");
    expect(source).not.toContain("setFlagsFromString");
    expect(source).not.toContain("appendSwitch(\"js-flags\"");
    expect(source).toContain("main heap is ~4GB-capped; heavy work runs in child workers.");
  });
});
