import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compileStatePath,
  createCompilePendingSummaryCache,
  legacyCompileStatePath,
  readCompilePendingSummary,
  readCompileStateFile,
  summarizeCompilePending,
  writeCompileStateFile,
} from "../../src/compile/state.js";

describe("summarizeCompilePending", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-state-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "raw", "2026-06-04"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("counts pending tails, drained files, and unseen raw files from consumed watermarks", async () => {
    await writeFile(join(root, "raw", "2026-06-04", "pending.md"), "abcdef");
    await writeFile(join(root, "raw", "2026-06-04", "drained.md"), "12345");
    await writeFile(join(root, "raw", "2026-06-04", "unseen.md"), "new");

    const summary = await summarizeCompilePending(root, {
      consumed: {
        "raw/2026-06-04/pending.md": { bytes: 2 },
        "raw/2026-06-04/drained.md": { bytes: 5 },
      },
    });

    expect(summary).toEqual({
      filesWithPendingTail: 1,
      pendingTailBytes: 4,
      totalRawFiles: 3,
      filesFullyDrained: 1,
      filesUnseen: 1,
    });
  });

  it("writes compile state under the gitignored var/compile runtime path", async () => {
    await writeCompileStateFile(root, {
      status: "completed",
      consumed: {
        "raw/2026-06-04/pending.md": { bytes: 2 },
      },
    });

    expect(compileStatePath(root)).toBe(join(root, "var", "compile", "state.json"));
    expect(existsSync(join(root, "state", "compile-state.json"))).toBe(false);
    await expect(readFile(join(root, "var", "compile", "state.json"), "utf-8")).resolves.toContain(
      "\"status\": \"completed\"",
    );
  });

  it("migrates legacy state/compile-state.json into var/compile/state.json on first read", async () => {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      join(root, "state", "compile-state.json"),
      `${JSON.stringify({
        consumed: {
          "raw/2026-06-04/pending.md": { bytes: 2 },
        },
      }, null, 2)}\n`,
    );

    const state = await readCompileStateFile(root);

    expect(state.consumed).toEqual({
      "raw/2026-06-04/pending.md": { bytes: 2 },
    });
    expect(legacyCompileStatePath(root)).toBe(join(root, "state", "compile-state.json"));
    expect(existsSync(join(root, "state", "compile-state.json"))).toBe(true);
    await expect(readFile(join(root, "var", "compile", "state.json"), "utf-8")).resolves.toContain(
      "raw/2026-06-04/pending.md",
    );
  });

  it("reuses cached pending summaries for repeated dashboard reads", async () => {
    await writeFile(join(root, "raw", "2026-06-04", "pending.md"), "abcdef");
    await mkdir(join(root, "var", "compile"), { recursive: true });
    await writeFile(
      join(root, "var", "compile", "state.json"),
      `${JSON.stringify({
        consumed: {
          "raw/2026-06-04/pending.md": { bytes: 2 },
        },
      }, null, 2)}\n`,
    );
    const cache = createCompilePendingSummaryCache();

    const first = await readCompilePendingSummary(root, { cache, now: () => 1_000 });
    const second = await readCompilePendingSummary(root, { cache, now: () => 1_100 });

    expect(second).toEqual(first);
    expect(cache.stats).toEqual({
      summaryCacheHits: 1,
      summaryRefreshes: 1,
    });
  });
});
