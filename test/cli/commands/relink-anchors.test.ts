import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRelinkAnchors } from "../../../src/cli/commands/relink-anchors.js";
import { curationContentLossCheck } from "../../../src/cli/commands/verify/curation-content-loss.js";
import { parseFrontmatter, serializeFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runRelinkAnchors", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "relink-anchors-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans and applies deterministic wikilink/code-anchor restoration", async () => {
    await writePage(
      "wiki/projects/memory-system.md",
      [
        "Memory System keeps tools/codex in prose and mentions src/index.ts without code formatting.",
        "The predecessor architecture remains relevant.",
      ].join("\n\n"),
    );
    await writeHistory(
      "wiki/projects/memory-system.md",
      "2026-05-31T12-00-00-000Z.md",
      [
        "Memory System keeps [[tools/codex]] and [[references/agentmemory-consolidation-architecture]].",
        "The command path was `src/index.ts`.",
      ].join("\n\n"),
    );

    const initial = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-01") });
    expect(initial.status).toBe("warn");

    const plan = await runRelinkAnchors({
      vaultRoot: tmp,
      mode: "plan",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(plan.pages).toHaveLength(1);
    expect(plan.pages[0]).toMatchObject({
      path: "wiki/projects/memory-system.md",
      restored: [
        expect.objectContaining({ kind: "wikilink", anchor: "tools/codex" }),
        expect.objectContaining({ kind: "wikilink", anchor: "references/agentmemory-consolidation-architecture", action: "append" }),
        expect.objectContaining({ kind: "code", anchor: "src/index.ts" }),
      ],
      needsReview: [],
    });
    expect(plan.report).toContain("Relink anchors plan");
    expect(plan.report).toContain("needs_review: 0");

    const applied = await runRelinkAnchors({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(applied.pages[0]?.archivePath).toBe("wiki/.history/wiki/projects/memory-system.md/2026-06-01T00-00-00-000Z.md");
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T00-00-00-000Z.md"))).toBe(true);

    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.body).toContain("[[tools/codex|tools/codex]]");
    expect(written.body).toContain("`src/index.ts`");
    expect(written.body).toContain("[[references/agentmemory-consolidation-architecture]]");
    expect(written.body).not.toMatch(/^##\s/m);
    expect(written.body).not.toMatch(/^\s*[-*+]\s/m);
    expect(written.frontmatter.version).toBe(2);
    expect(written.frontmatter.updated).toBe("2026-06-01");
    expect(written.frontmatter.last_accessed).toBe("2026-06-01");
    expect(written.frontmatter.supersedes).toEqual([
      expect.objectContaining({
        path: "wiki/.history/wiki/projects/memory-system.md/2026-06-01T00-00-00-000Z.md",
        version: 1,
      }),
    ]);

    const final = await curationContentLossCheck.run({ vaultRoot: tmp, now: () => new Date("2026-06-01") });
    expect(final.status).toBe("pass");
  });

  it("filters by page slug", async () => {
    await writePage("wiki/projects/one.md", "One names tools/one plainly.");
    await writeHistory("wiki/projects/one.md", "2026-05-31T12-00-00-000Z.md", "One names [[tools/one]].");
    await writePage("wiki/projects/two.md", "Two names tools/two plainly.");
    await writeHistory("wiki/projects/two.md", "2026-05-31T12-00-00-000Z.md", "Two names [[tools/two]].");

    const plan = await runRelinkAnchors({
      vaultRoot: tmp,
      mode: "plan",
      page: "two",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(plan.pages.map((page) => page.path)).toEqual(["wiki/projects/two.md"]);
  });

  async function writePage(relPath: string, body: string): Promise<void> {
    await writeFileAt(relPath, serializeFrontmatter({
      type: "projects",
      title: "Memory System",
      created: "2026-05-30",
      updated: "2026-05-31",
      version: 1,
    }, `${body.trim()}\n`));
  }

  async function writeHistory(relPath: string, timestamp: string, body: string): Promise<void> {
    await writeFileAt(`wiki/.history/${relPath}/${timestamp}`, serializeFrontmatter({
      type: "projects",
      title: "Memory System",
      created: "2026-05-30",
      updated: "2026-05-31",
      version: 1,
    }, `${body.trim()}\n`));
  }

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});
