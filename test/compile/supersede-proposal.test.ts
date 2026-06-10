import { describe, it, expect } from "vitest";
import { applyOperation } from "../../src/compile/execute.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";
import { readFile, readdir, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("supersede_page proposal with temporal patch", () => {
  it("does NOT mutate the old page", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-test-"));
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });

    const oldContent = serializeFrontmatter(
      { type: "tools", title: "Old Tool", created: "2025-01-01", updated: "2025-01-01", status: "active" as const },
      "old body\n"
    );
    await writeFile(join(wikiDir, "old-tool.md"), oldContent);

    const now = new Date("2026-06-09T12:00:00Z");
    await applyOperation(
      root,
      {
        kind: "supersede_page",
        old_page: "wiki/tools/old-tool.md",
        new_page: "wiki/tools/new-tool.md",
        reason: "upgraded to v2",
        valid_to: "2026-06-09",
      },
      now,
    );

    // Old page MUST remain unchanged — staging invariant
    const oldAfter = await readFile(join(wikiDir, "old-tool.md"), "utf-8");
    const oldParsed = parseFrontmatter(oldAfter);
    expect(oldParsed.frontmatter.status).toBe("active");
    expect(oldParsed.frontmatter.valid_until).toBeUndefined();
  });

  it("stores temporal patch metadata in the proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-test-"));
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });
    await writeFile(
      join(wikiDir, "old-tool.md"),
      serializeFrontmatter(
        { type: "tools", title: "Old Tool", created: "2025-01-01", updated: "2025-01-01" },
        "old body\n"
      ),
    );

    const now = new Date("2026-06-09T12:00:00Z");
    await applyOperation(root, {
      kind: "supersede_page",
      old_page: "wiki/tools/old-tool.md",
      new_page: "wiki/tools/new-tool.md",
      reason: "upgraded to v2",
      valid_to: "2026-06-09",
    }, now);

    const proposedDir = join(root, "wiki", "compile-proposed");
    const files = await readdir(proposedDir);
    const proposalFile = files.find(f => f.startsWith("supersede-old-tool"));
    expect(proposalFile).toBeDefined();

    const proposal = await readFile(join(proposedDir, proposalFile!), "utf-8");
    const parsed = parseFrontmatter(proposal);
    expect(parsed.frontmatter.observed_at).toBe("2026-06-09");
    expect(parsed.frontmatter.old_page_patch).toEqual({
      valid_until: "2026-06-09",
      status: "superseded",
    });
    expect(parsed.frontmatter.searchable).toBe(false);
  });

  it("defaults old_page_patch.valid_until to proposal date when valid_to omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mf-test-"));
    const wikiDir = join(root, "wiki", "tools");
    await mkdir(wikiDir, { recursive: true });

    const now = new Date("2026-06-09T12:00:00Z");
    await applyOperation(root, {
      kind: "supersede_page",
      old_page: "wiki/tools/old-tool.md",
      new_page: "wiki/tools/new-tool.md",
      reason: "upgraded to v2",
    }, now);

    const proposedDir = join(root, "wiki", "compile-proposed");
    const files = await readdir(proposedDir);
    const proposal = await readFile(join(proposedDir, files[0]!), "utf-8");
    const parsed = parseFrontmatter(proposal);
    expect(parsed.frontmatter.old_page_patch).toEqual({
      valid_until: "2026-06-09",
      status: "superseded",
    });
  });
});
