import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCounts, loadLastCompile, loadSyncState } from "../../src/dashboard/loaders.js";

describe("dashboard loaders", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "dash-loaders-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("loadCounts returns zero for an empty vault", async () => {
    await mkdir(join(tmp, "wiki"), { recursive: true });
    await mkdir(join(tmp, "raw"), { recursive: true });
    await mkdir(join(tmp, "crystals"), { recursive: true });

    await expect(loadCounts(tmp)).resolves.toEqual({
      wikiPages: 0,
      rawObservations: 0,
      crystals: 0,
    });
  });

  it("loadCounts counts .md files across all three trees, ignoring other extensions", async () => {
    await mkdir(join(tmp, "wiki", "projects"), { recursive: true });
    await mkdir(join(tmp, "raw", "2026-05-23"), { recursive: true });
    await mkdir(join(tmp, "crystals"), { recursive: true });
    await writeFile(join(tmp, "wiki", "a.md"), "# A\n");
    await writeFile(join(tmp, "wiki", "projects", "b.md"), "# B\n");
    await writeFile(join(tmp, "wiki", "ignore.txt"), "nope\n");
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(tmp, "raw", "2026-05-23", `${i}.md`), `raw ${i}\n`);
    }

    await expect(loadCounts(tmp)).resolves.toEqual({
      wikiPages: 2,
      rawObservations: 5,
      crystals: 0,
    });
  });

  it("loadLastCompile returns the most recent compile line", async () => {
    await writeFile(
      join(tmp, "log.md"),
      [
        "## [2026-05-21 10:00:00] compile | older",
        "other line",
        "## [2026-05-22 11:00:00] compile | newest",
        "",
      ].join("\n"),
    );

    await expect(loadLastCompile(tmp)).resolves.toEqual({
      timestamp: "2026-05-22 11:00:00",
      line: "## [2026-05-22 11:00:00] compile | newest",
    });
  });

  it("loadSyncState returns null when missing and parses valid JSON when present", async () => {
    await expect(loadSyncState(tmp)).resolves.toBeNull();
    await writeFile(
      join(tmp, ".sync-state.json"),
      JSON.stringify({
        last_sync_attempt: "2026-05-23T00:00:00.000Z",
        last_sync_success: "2026-05-23T00:00:00.000Z",
        pending_push_count: 0,
        conflicts_pending: 0,
        conflict_files: [],
      }),
    );

    await expect(loadSyncState(tmp)).resolves.toEqual({
      lastSyncAttempt: "2026-05-23T00:00:00.000Z",
      lastSyncSuccess: "2026-05-23T00:00:00.000Z",
      pendingPushCount: 0,
      conflictsPending: 0,
      conflictFiles: [],
    });
  });
});
