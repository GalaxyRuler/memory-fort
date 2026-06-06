import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../../src/compile/index.js";

describe("rebuildIndex", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-index-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("regenerates a deterministic sectioned index from canonical wiki pages", async () => {
    await writePage("wiki/projects/acme.md", "projects", "Acme", "Acme tracks marketplace work.");
    await writePage("wiki/projects/agentmemory.md", "projects", "agentmemory", "Agentmemory stores long-term memory.");
    await writePage("wiki/tools/codex.md", "tools", "Codex", "Codex is the coding agent.");
    await writePage("wiki/decisions/append-only.md", "decisions", "Append Only", "Compile stays append-only.");
    await writePage("wiki/compile-proposed/draft.md", "projects", "Draft", "Draft should stay out.");
    await writePage("wiki/archive/old.md", "projects", "Old", "Archived should stay out.");
    await writePage("wiki/.audit/llm.md", "tools", "Audit", "Audit should stay out.");
    await writeFile(join(tmp, "index.md"), "# stale\n\n- [Acme](wiki/projects/acme.md) - duplicate\n");

    const first = await rebuildIndex(tmp);
    const second = await rebuildIndex(tmp);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
    expect(first.content).toContain("## Projects\n\n- [Acme](wiki/projects/acme.md) - Acme tracks marketplace work.\n- [agentmemory](wiki/projects/agentmemory.md) - Agentmemory stores long-term memory.");
    expect(first.content).toContain("## Decisions\n\n- [Append Only](wiki/decisions/append-only.md) - Compile stays append-only.");
    expect(first.content).toContain("## Tools\n\n- [Codex](wiki/tools/codex.md) - Codex is the coding agent.");
    expect(first.content).not.toContain("Draft");
    expect(first.content).not.toContain("Old");
    expect(first.content).not.toContain("Audit");

    const written = await readFile(join(tmp, "index.md"), "utf-8");
    expect(written).toBe(first.content);
    expect(written.match(/wiki\/projects\/acme\.md/g)).toHaveLength(1);
  });

  async function writePage(relPath: string, type: string, title: string, body: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(
      fullPath,
      [
        "---",
        `type: ${type}`,
        `title: ${title}`,
        "created: 2026-05-31",
        "updated: 2026-05-31",
        "---",
        "",
        body,
        "",
      ].join("\n"),
    );
  }
});
