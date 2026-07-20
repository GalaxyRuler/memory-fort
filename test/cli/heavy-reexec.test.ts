import { describe, expect, it } from "vitest";
import { shouldReexecHeavy } from "../../src/cli/heavy-reexec.js";

describe("shouldReexecHeavy", () => {
  const argv = (cmd: string) => ["node", "cli.mjs", cmd, "--plan"];

  it("re-execs full-corpus commands", () => {
    for (const cmd of ["consolidate", "procedure", "refresh", "rebless", "eval-retrieval"]) {
      expect(shouldReexecHeavy(argv(cmd), {})).toBe(true);
    }
  });

  it("re-execs the real Commander argv shapes for provider embedding maintenance", () => {
    expect(shouldReexecHeavy(["node", "cli.mjs", "provider", "reindex-embeddings", "--apply"], {})).toBe(true);
    expect(shouldReexecHeavy(["node", "cli.mjs", "provider", "rebless-embeddings", "--plan"], {})).toBe(true);
    // Other provider subcommands are light.
    expect(shouldReexecHeavy(["node", "cli.mjs", "provider", "list-embedders"], {})).toBe(false);
  });

  it("leaves bounded and light commands alone", () => {
    // curate --refresh reads pages individually with byte caps — NOT a
    // full-corpus load; it must not pay the re-exec.
    expect(shouldReexecHeavy(["node", "cli.mjs", "curate", "--refresh"], {})).toBe(false);
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
