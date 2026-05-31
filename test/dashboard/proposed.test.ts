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
    expect(parseProposedActionBody({ kind: "compile", slug: "iaqar" })).toEqual({
      ok: true,
      kind: "compile",
      slug: "iaqar",
    });
  });

  it("promotes a compile proposal by applying the staged operation and deleting the proposal", async () => {
    await writeFileAt("index.md", "# Memory Index\n\n");
    await writeFileAt("wiki/compile-proposed/iaqar.md", compileProposal({
      kind: "write_page",
      path: "wiki/projects/iaqar.md",
      frontmatter: {
        type: "projects",
        title: "iAqar",
      },
      body: "iAqar marketplace notes.",
    }));

    const result = await promoteProposedDraft(tmp, "compile", "iaqar");

    expect(result).toEqual({ promotedPath: "wiki/projects/iaqar.md" });
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "iaqar.md"))).toBe(false);
    const written = await readFile(join(tmp, "wiki", "projects", "iaqar.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.title).toBe("iAqar");
    expect(parsed.body).toContain("iAqar marketplace notes.");
    await expect(readFile(join(tmp, "index.md"), "utf-8"))
      .resolves.toContain("- [iAqar](wiki/projects/iaqar.md) - iAqar marketplace notes.");
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/projects/iaqar.md", "index.md", "wiki/compile-proposed/iaqar.md"],
      message: "promote compile proposal: iaqar",
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
      .rejects.toThrow("knowledge-page update requires rewrite_page");
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.not.toContain("Reviewed compile addition.");
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "memory-fort.md"))).toBe(true);
  });

  it("rejects a compile proposal by deleting only the proposal", async () => {
    await writeFileAt("wiki/projects/iaqar.md", [
      "---",
      "type: projects",
      "title: iAqar",
      "---",
      "",
      "Original canonical content.",
      "",
    ].join("\n"));
    await writeFileAt("wiki/compile-proposed/iaqar.md", compileProposal({
      kind: "append_page",
      path: "wiki/projects/iaqar.md",
      section: "Rejected addition.",
    }));

    const result = await rejectProposedDraft(tmp, "compile", "iaqar");

    expect(result).toEqual({ rejectedPath: "wiki/compile-proposed/iaqar.md" });
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "iaqar.md"))).toBe(false);
    const canonical = await readFile(join(tmp, "wiki", "projects", "iaqar.md"), "utf-8");
    expect(canonical).toContain("Original canonical content.");
    expect(canonical).not.toContain("Rejected addition.");
    expect(commitVaultChange).toHaveBeenCalledWith({
      memoryRoot: tmp,
      paths: ["wiki/compile-proposed/iaqar.md"],
      message: "reject compile proposal: iaqar",
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
