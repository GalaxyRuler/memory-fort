import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCompileOperations,
  parseCompileOperationsBlock,
} from "../../src/compile/execute.js";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("compile execute operations", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-execute-"));
    await writeFileAt("raw/2026-05-28/a.md", rawPage("A", "session-a"));
    await writeFileAt("raw/2026-05-28/b.md", rawPage("B", "session-b"));
    await writeFileAt("wiki/projects/memory-fort.md", page("projects", "Memory Fort"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses fenced compile-ops JSON", () => {
    const parsed = parseCompileOperationsBlock([
      "response text",
      "```compile-ops",
      JSON.stringify({ operations: [{ kind: "write_page", path: "wiki/lessons/x.md", body: "Body" }] }),
      "```",
    ].join("\n"));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.operations).toHaveLength(1);
  });

  it("applies high-confidence write_page operations after grounding and redaction", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/lessons/compile-safety.md",
        frontmatter: {
          type: "lessons",
          title: "Compile Safety",
          relations: {
            derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"],
            mentions: ["wiki/projects/memory-fort.md", "wiki/projects/missing.md"],
          },
        },
        body: "Keep compile execution append-only.\nwiki/projects/missing.md\nOPENROUTER_API_KEY=sk-live-secret",
      }],
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/lessons/compile-safety.md"]);
    expect(result.proposed).toEqual([]);
    const written = await readFile(join(tmp, "wiki", "lessons", "compile-safety.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.relations).toEqual({
      derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"],
      mentions: ["wiki/projects/memory-fort.md"],
    });
    expect(parsed.body).not.toContain("wiki/projects/missing.md");
    expect(parsed.body).not.toContain("sk-live-secret");
    expect(parsed.body).toContain("[REDACTED]");
  });

  it("stages low-confidence operations without writing canonical pages", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/lessons/thin.md",
        frontmatter: {
          type: "lessons",
          title: "Thin",
          relations: { derived_from: ["raw/2026-05-28/a.md"] },
        },
        body: "Only one raw source.",
      }],
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/thin.md"]);
    expect(existsSync(join(tmp, "wiki", "lessons", "thin.md"))).toBe(false);
    expect(await readFile(join(tmp, "wiki", "compile-proposed", "thin.md"), "utf-8"))
      .toContain('"path": "wiki/lessons/thin.md"');
  });

  it("plans operations without writing files", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      plan: true,
      operations: [{
        kind: "append_log",
        path: "log.md",
        line: "## [2026-05-28T12:00:00.000Z] compile | executed",
      }],
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.planned).toEqual(["log.md"]);
    expect(existsSync(join(tmp, "log.md"))).toBe(false);
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function page(type: string, title: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-28",
    "updated: 2026-05-28",
    "---",
    "",
    `${title} body.`,
  ].join("\n");
}

function rawPage(title: string, session: string): string {
  return [
    "---",
    "type: raw-session",
    `title: ${title}`,
    "created: 2026-05-28",
    "updated: 2026-05-28",
    `session: ${session}`,
    "---",
    "",
    `${title} body.`,
  ].join("\n");
}
