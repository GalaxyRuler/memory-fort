import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRewriteImportedTimestamps } from "../../../src/cli/commands/rewrite-imported-timestamps.js";
import { parseFrontmatter, serializeFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runRewriteImportedTimestamps", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "rewrite-imported-timestamps-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("adds observed_at to imported files with UUIDv7 agentmemory keys and skips existing values", async () => {
    await writePage(
      "raw/2026-05-26/imported.md",
      {
        type: "raw-session",
        title: "Imported",
        created: "2026-05-26",
        updated: "2026-05-26",
        imported_from: {
          system: "agentmemory",
          original_key: "mem:obs:019e45fc-5e01-7180-9f0c-114a3b1f941a",
        },
      },
    );
    await writePage(
      "raw/2026-05-26/already.md",
      {
        type: "raw-session",
        title: "Already",
        created: "2026-05-26",
        updated: "2026-05-26",
        observed_at: "2026-05-19",
        imported_from: {
          system: "agentmemory",
          original_key: "mem:obs:019e45fc-5e01-7180-9f0c-114a3b1f941a",
        },
      },
    );
    await writePage(
      "raw/2026-05-26/plain.md",
      {
        type: "raw-session",
        title: "Plain",
        created: "2026-05-26",
        updated: "2026-05-26",
        imported_from: {
          system: "agentmemory",
          original_key: "mem:obs:not-a-uuid",
        },
      },
    );

    const result = await runRewriteImportedTimestamps({ root: tmp });

    expect(result).toEqual({ scanned: 3, updated: 1, skippedExisting: 1, skippedNoTimestamp: 1 });
    expect((await readFrontmatter("raw/2026-05-26/imported.md"))["observed_at"]).toBe("2026-05-20");
    expect((await readFrontmatter("raw/2026-05-26/already.md"))["observed_at"]).toBe("2026-05-19");
    expect((await readFrontmatter("raw/2026-05-26/plain.md"))["observed_at"]).toBeUndefined();

    const second = await runRewriteImportedTimestamps({ root: tmp });
    expect(second).toEqual({ scanned: 3, updated: 0, skippedExisting: 2, skippedNoTimestamp: 1 });
  });

  async function writePage(relPath: string, frontmatter: Record<string, unknown>): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, serializeFrontmatter(frontmatter as never, "Body.\n"));
  }

  async function readFrontmatter(relPath: string): Promise<Record<string, unknown>> {
    const content = await readFile(join(tmp, ...relPath.split("/")), "utf-8");
    return parseFrontmatter(content).frontmatter as Record<string, unknown>;
  }
});
