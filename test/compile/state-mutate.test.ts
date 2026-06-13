import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mutateCompileStateFile,
  readCompileStateFile,
  readConsumedMap,
  writeCompileStateFile,
} from "../../src/compile/state.js";

describe("mutateCompileStateFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "compile-state-mutate-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("applies the mutator to the on-disk state and persists the result", async () => {
    await writeCompileStateFile(root, { consumed: { "raw/a.md": { bytes: 5 } } });
    const next = await mutateCompileStateFile(root, (state) => ({
      ...state,
      consumed: { ...readConsumedMap(state), "raw/b.md": { bytes: 9 } },
    }));
    expect(readConsumedMap(next)).toEqual({
      "raw/a.md": { bytes: 5 },
      "raw/b.md": { bytes: 9 },
    });
    expect(readConsumedMap(await readCompileStateFile(root))).toEqual(readConsumedMap(next));
  });

  it("does not lose updates from concurrent mutators (no last-write-wins)", async () => {
    await writeCompileStateFile(root, { consumed: {} });
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        mutateCompileStateFile(root, (state) => ({
          ...state,
          consumed: { ...readConsumedMap(state), [`raw/f${i}.md`]: { bytes: i + 1 } },
        })),
      ),
    );
    const final = readConsumedMap(await readCompileStateFile(root));
    expect(Object.keys(final).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `raw/f${i}.md`).sort(),
    );
  });

  it("passes an empty state to the mutator when the state file is corrupt", async () => {
    const { atomicWrite } = await import("../../src/storage/atomic-write.js");
    const { compileStatePath } = await import("../../src/compile/state.js");
    await atomicWrite(compileStatePath(root), "{not json");
    const next = await mutateCompileStateFile(root, (state) => ({
      ...state,
      consumed: { "raw/a.md": { bytes: 1 } },
    }));
    expect(readConsumedMap(next)).toEqual({ "raw/a.md": { bytes: 1 } });
  });
});
