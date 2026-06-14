import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  applyCompileOperations,
  isKnowledgePageType,
} from "../../src/compile/execute.js";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseFrontmatter } from "../../src/storage/frontmatter.js";

describe("executor: wiki/preferences/ pages", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "exec-pref-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "wiki", "preferences"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("accepts write_page targeting wiki/preferences/", async () => {
    const ops = [
      {
        kind: "write_page" as const,
        path: "wiki/preferences/no-mocks-in-tests.md",
        frontmatter: {
          type: "preferences",
          title: "No Mocks In Tests",
          cognitive_type: "core",
          source: "compile-execute",
          confidence: 0.9,
          tags: ["preference", "constraint"],
        },
        body: "Do not mock the database in integration tests.",
      },
    ];

    const result = await applyCompileOperations({
      vaultRoot: root,
      operations: ops,
    });

    expect(result.rejected).toEqual([]);
    expect(result.applied).toContain("wiki/preferences/no-mocks-in-tests.md");
    const created = join(root, "wiki", "preferences", "no-mocks-in-tests.md");
    expect(existsSync(created)).toBe(true);
    const content = await readFile(created, "utf-8");
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.type).toBe("preferences");
    expect(parsed.frontmatter.cognitive_type).toBe("core");
    expect(parsed.frontmatter.source).toBe("compile-execute");
    expect(parsed.body).toContain("Do not mock the database");
  });

  it("rejects unknown category still rejected", async () => {
    const ops = [
      {
        kind: "write_page" as const,
        path: "wiki/boguscategory/foo.md",
        frontmatter: { type: "boguscategory", title: "Foo" },
        body: "test",
      },
    ];

    const result = await applyCompileOperations({
      vaultRoot: root,
      operations: ops,
    });

    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0]!.reason).toContain("unknown wiki page category");
  });

  it("defaults cognitive_type to core for append-to-create conversions on preferences", async () => {
    const ops = [
      {
        kind: "append_page" as const,
        path: "wiki/preferences/use-tabs.md",
        section: "## Directive\n\nAlways use tabs, never spaces.",
      },
    ];

    const result = await applyCompileOperations({
      vaultRoot: root,
      operations: ops,
    });

    expect(result.rejected).toEqual([]);
    const created = join(root, "wiki", "preferences", "use-tabs.md");
    expect(existsSync(created)).toBe(true);
    const content = await readFile(created, "utf-8");
    const parsed = parseFrontmatter(content);
    expect(parsed.frontmatter.cognitive_type).toBe("core");
    expect(parsed.frontmatter.source).toBe("compile-execute");
  });

  it("treats preferences as a knowledge page type", () => {
    expect(isKnowledgePageType("preferences")).toBe(true);
  });
});
