import { describe, expect, it } from "vitest";
import { shouldReexecHeavy } from "../../src/cli/heavy-reexec.js";

describe("shouldReexecHeavy", () => {
  const argv = (cmd: string) => ["node", "cli.mjs", cmd, "--plan"];

  it("re-execs full-corpus commands", () => {
    for (const cmd of ["consolidate", "procedure", "refresh", "rebless"]) {
      expect(shouldReexecHeavy(argv(cmd), {})).toBe(true);
    }
  });

  it("leaves bounded and light commands alone", () => {
    for (const cmd of ["search", "verify", "thread", "discover-threads", "compile"]) {
      expect(shouldReexecHeavy(argv(cmd), {})).toBe(false);
    }
  });

  it("never re-execs twice", () => {
    expect(shouldReexecHeavy(argv("consolidate"), { MEMORY_HEAVY_REEXEC: "1" })).toBe(false);
  });

  it("respects an explicit user heap setting", () => {
    expect(shouldReexecHeavy(argv("consolidate"), { NODE_OPTIONS: "--max-old-space-size=4096" })).toBe(false);
  });
});
