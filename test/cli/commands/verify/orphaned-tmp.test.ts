import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkOrphanedTmp } from "../../../../src/cli/commands/verify/orphaned-tmp.js";

describe("storage.orphaned-tmp verify check", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verify-orphaned-tmp-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not surface stale temporary files from retained archive or system paths", async () => {
    await writeOldTmp("wiki/_archive/retained.tmp");
    await writeOldTmp("raw/.compact-archive/retained.tmp");

    const result = await checkOrphanedTmp({
      vaultRoot: root,
      now: () => new Date("2026-07-24T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ id: "storage.orphaned-tmp", status: "pass" });
  });

  async function writeOldTmp(relPath: string): Promise<void> {
    const fullPath = join(root, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "interrupted write", "utf8");
    const old = new Date("2026-07-24T10:00:00.000Z");
    await utimes(fullPath, old, old);
  }
});
