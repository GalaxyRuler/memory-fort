import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourceFieldCheck } from "../../../../src/cli/commands/verify/source-field.js";
import { serializeFrontmatter, type Frontmatter } from "../../../../src/storage/frontmatter.js";

describe("sourceFieldCheck", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "source-field-check-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("passes when all live wiki pages have source provenance", async () => {
    await writeWiki("wiki/projects/a.md", "A", "codex");
    await writeWiki("wiki/archive/old.md", "Old", "unknown");

    const result = await sourceFieldCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-27") });

    expect(result).toMatchObject({
      id: "frontmatter.source",
      status: "pass",
      detail: "all 1 live wiki pages have source provenance",
    });
  });

  it("warns for one or two missing live wiki sources", async () => {
    await writeWiki("wiki/projects/a.md", "A", "unknown");
    await writeWiki("wiki/projects/b.md", "B");
    await writeWiki("wiki/projects/c.md", "C", "codex");

    const result = await sourceFieldCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-27") });

    expect(result).toMatchObject({
      id: "frontmatter.source",
      status: "warn",
      detail: "2/3 live wiki pages lack source",
      suggestedFix: "run `memory backfill-source --apply`",
    });
  });

  it("fails for three or more missing live wiki sources and reports examples", async () => {
    await writeWiki("wiki/projects/a.md", "A", "unknown");
    await writeWiki("wiki/projects/b.md", "B");
    await writeWiki("wiki/projects/c.md", "C");
    await writeWiki("wiki/projects/d.md", "D", "codex");

    const result = await sourceFieldCheck.run({ vaultRoot: tmp, now: () => new Date("2026-05-27") });

    expect(result).toMatchObject({
      id: "frontmatter.source",
      status: "fail",
      suggestedFix: "run `memory backfill-source --apply`",
    });
    expect(result.detail).toContain("3/4 live wiki pages lack source");
    expect(result.detail).toContain("wiki/projects/a.md");
  });

  async function writeWiki(relPath: string, title: string, source?: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    const frontmatter: Frontmatter = {
      type: "projects",
      title,
      created: "2026-05-20",
      updated: "2026-05-20",
      status: "active",
      ...(source === undefined ? {} : { source }),
    };
    await writeFile(fullPath, serializeFrontmatter(frontmatter, `${title} body.\n`), "utf-8");
  }
});
