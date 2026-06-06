import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseProposedActionBody,
  promoteProposedDraft,
  rejectProposedDraft,
} from "../../src/dashboard/proposed.js";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

const commitVaultChange = vi.hoisted(() =>
  vi.fn(async () => ({ kind: "no-changes" as const }))
);

vi.mock("../../src/sync/commit-vault-change.js", () => ({
  commitVaultChange,
}));

describe("dashboard proposed draft actions", () => {
  let tmp: string;

  beforeEach(async () => {
    commitVaultChange.mockClear();
    tmp = await mkdtemp(join(tmpdir(), "dashboard-proposed-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("accepts compile as a proposed action kind", () => {
    expect(parseProposedActionBody({ kind: "compile", slug: "acme" })).toEqual({
      ok: true,
      kind: "compile",
      slug: "acme",
    });
  });

  it("promotes a compile proposal by applying the staged operation and deleting the proposal", async () => {
    await writeFileAt("index.md", "# Memory Index\n\n");
    await writeFileAt("wiki/compile-proposed/acme.md", compileProposal({
      kind: "write_page",
      path: "wiki/projects/acme.md",
      frontmatter: {
        type: "projects",
        title: "Acme",
      },
      body: "Acme marketplace notes.",
    }));

    const result = await promoteProposedDraft(tmp, "compile", "acme");

    expect(result).toEqual({ promotedPath: "wiki/projects/acme.md" });
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "acme.md"))).toBe(false);
    const written = await readFile(join(tmp, "wiki", "projects", "acme.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.title).toBe("Acme");
    expect(parsed.body).toContain("Acme marketplace notes.");
    await expect(readFile(join(tmp, "index.md"), "utf-8"))
      .resolves.toContain("- [Acme](wiki/projects/acme.md) - Acme marketplace notes.");
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/projects/acme.md", "index.md", "wiki/compile-proposed/acme.md"],
      message: "promote compile proposal: acme",
    });
  });

  it("promotes append_page compile proposals for chronological thread pages", async () => {
    await writeFileAt("wiki/threads/memory-fort.md", [
      "---",
      "type: threads",
      "title: Memory Fort",
      "---",
      "",
      "Existing body.",
      "",
    ].join("\n"));
    await writeFileAt("wiki/compile-proposed/memory-fort.md", compileProposal({
      kind: "append_page",
      path: "wiki/threads/memory-fort.md",
      section: "## 2026-05-30\n\nReviewed compile addition.",
    }));

    const result = await promoteProposedDraft(tmp, "compile", "memory-fort");

    expect(result).toEqual({ promotedPath: "wiki/threads/memory-fort.md" });
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "memory-fort.md"))).toBe(false);
    const written = await readFile(join(tmp, "wiki", "threads", "memory-fort.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.body).toContain("Existing body.");
    expect(parsed.body).toContain("Reviewed compile addition.");
  });

  it("commits archive history when promoting rewrite_page compile proposals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    try {
      await writeFileAt("wiki/references/section-patch-fixture.md", [
        "---",
        "type: references",
        "title: Section-Patch Fixture",
        "version: 2",
        "---",
        "",
        "Existing narrative body.",
        "",
      ].join("\n"));
      await writeFileAt("wiki/compile-proposed/section-patch-fixture.md", compileProposal({
        kind: "rewrite_page",
        path: "wiki/references/section-patch-fixture.md",
        body: "Rewritten narrative body.",
      }));

      const result = await promoteProposedDraft(tmp, "compile", "section-patch-fixture");

      const archivePath = "wiki/.history/wiki/references/section-patch-fixture.md/2026-06-01T12-00-00-000Z.md";
      expect(result).toEqual({ promotedPath: "wiki/references/section-patch-fixture.md" });
      expect(existsSync(join(tmp, ...archivePath.split("/")))).toBe(true);
      expect(commitVaultChange).toHaveBeenCalledWith({
        memoryRoot: tmp,
        paths: [
          "wiki/references/section-patch-fixture.md",
          archivePath,
          "wiki/compile-proposed/section-patch-fixture.md",
        ],
        message: "promote compile proposal: section-patch-fixture",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to promote append_page compile proposals against existing knowledge pages", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", [
      "---",
      "type: projects",
      "title: Memory Fort",
      "---",
      "",
      "Existing body.",
      "",
    ].join("\n"));
    await writeFileAt("wiki/compile-proposed/memory-fort.md", compileProposal({
      kind: "append_page",
      path: "wiki/projects/memory-fort.md",
      section: "## 2026-05-30\n\nReviewed compile addition.",
    }));

    await expect(promoteProposedDraft(tmp, "compile", "memory-fort"))
      .rejects.toThrow("knowledge-page update requires narrative synthesis");
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.not.toContain("Reviewed compile addition.");
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "memory-fort.md"))).toBe(true);
  });

  it("rejects a compile proposal by deleting only the proposal", async () => {
    await writeFileAt("wiki/projects/acme.md", [
      "---",
      "type: projects",
      "title: Acme",
      "---",
      "",
      "Original canonical content.",
      "",
    ].join("\n"));
    await writeFileAt("wiki/compile-proposed/acme.md", compileProposal({
      kind: "append_page",
      path: "wiki/projects/acme.md",
      section: "Rejected addition.",
    }));

    const result = await rejectProposedDraft(tmp, "compile", "acme");

    expect(result).toEqual({ rejectedPath: "wiki/compile-proposed/acme.md" });
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "acme.md"))).toBe(false);
    const canonical = await readFile(join(tmp, "wiki", "projects", "acme.md"), "utf-8");
    expect(canonical).toContain("Original canonical content.");
    expect(canonical).not.toContain("Rejected addition.");
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/compile-proposed/acme.md"],
      message: "reject compile proposal: acme",
    });
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function compileProposal(operation: Record<string, unknown>): string {
  return [
    "---",
    "type: references",
    "title: compile proposal",
    "status: active",
    "lifecycle: proposed",
    "---",
    "",
    `# Compile proposal: ${operation["path"]}`,
    "",
    "Reason: low confidence",
    "",
    "```compile-op",
    JSON.stringify(operation, null, 2),
    "```",
    "",
  ].join("\n");
}
