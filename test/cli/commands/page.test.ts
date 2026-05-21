import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPage } from "../../../src/cli/commands/page.js";

describe("runPage", () => {
  let tmp: string;
  let root: string;
  let origMemRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "page-"));
    root = join(tmp, ".memory");
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(join(root, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("target resolves by relative path", async () => {
    await writeWikiPage("projects/agentmemory.md", {
      type: "projects",
      title: "agentmemory",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Hello world.");

    const result = await runPage("projects/agentmemory.md");

    expect(result.path).toBe("projects/agentmemory.md");
    expect(result.rendered).toContain("Hello world.");
    expect(result.rendered).toContain("agentmemory");
    expect(result.rendered).toContain("Created:    2026-05-22");
  });

  it("target resolves by filename without extension", async () => {
    await writeWikiPage("projects/agentmemory.md", {
      type: "projects",
      title: "agentmemory",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Hello world.");

    const result = await runPage("agentmemory");

    expect(result.path).toBe("projects/agentmemory.md");
    expect(result.rendered).toContain("Hello world.");
    expect(result.rendered).toContain("agentmemory");
  });

  it("target with .md extension stripped equivalently", async () => {
    await writeWikiPage("projects/agentmemory.md", {
      type: "projects",
      title: "agentmemory",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Hello world.");

    const withExtension = await runPage("agentmemory.md");
    const withoutExtension = await runPage("agentmemory");

    expect(withExtension.path).toBe(withoutExtension.path);
  });

  it("ambiguous filename throws", async () => {
    await writeWikiPage("projects/foo.md", {
      type: "projects",
      title: "Project Foo",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Project.");
    await writeWikiPage("lessons/foo.md", {
      type: "lessons",
      title: "Lesson Foo",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Lesson.");

    await expect(runPage("foo")).rejects.toThrow(/ambiguous/);
    await expect(runPage("foo")).rejects.toThrow(/projects\/foo\.md/);
    await expect(runPage("foo")).rejects.toThrow(/lessons\/foo\.md/);
  });

  it("unknown target throws with memory grep hint", async () => {
    await expect(runPage("ghost")).rejects.toThrow(
      'no wiki page matches "ghost"',
    );
    await expect(runPage("ghost")).rejects.toThrow(/memory grep/);
  });

  it("missing wiki directory throws with memory init hint", async () => {
    await rm(join(root, "wiki"), { recursive: true, force: true });
    await writeFile(join(root, "schema.md"), "# Schema\n");

    await expect(runPage("anything")).rejects.toThrow(/memory init/);
  });

  it("relations resolved and rendered with titles", async () => {
    await writeWikiPage("projects/a.md", {
      type: "projects",
      title: "A-page",
      created: "2026-05-22",
      updated: "2026-05-22",
      relations: { uses: ["b", "c"] },
    }, "A body.");
    await writeWikiPage("projects/b.md", {
      type: "projects",
      title: "B-page",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "B body.");

    const result = await runPage("a");

    expect(result.relations).toHaveLength(2);
    expect(result.relations[0]).toEqual({
      key: "uses",
      target: "b",
      resolvedPath: "projects/b.md",
      resolvedTitle: "B-page",
    });
    expect(result.relations[1]).toEqual({
      key: "uses",
      target: "c",
      resolvedPath: null,
      resolvedTitle: null,
    });
    expect(result.rendered).toContain("b -> projects/b.md (B-page)");
    expect(result.rendered).toContain("c -> [unresolved] (?)");
  });

  it("inbound references discovered via wikilink AND via relations", async () => {
    await writeWikiPage("projects/x.md", {
      type: "projects",
      title: "X-page",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Target.");
    await writeWikiPage("lessons/y.md", {
      type: "lessons",
      title: "Y-page",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "See [[projects/x]].");
    await writeWikiPage("projects/z.md", {
      type: "projects",
      title: "Z-page",
      created: "2026-05-22",
      updated: "2026-05-22",
      relations: { depends_on: ["projects/x"] },
    }, "Relation only.");

    const result = await runPage("projects/x.md");

    expect(result.inbound).toHaveLength(2);
    expect(result.inbound[0]).toMatchObject({
      fromPath: "lessons/y.md",
      via: "wikilink",
    });
    expect(result.inbound[1]).toMatchObject({
      fromPath: "projects/z.md",
      via: "relation:depends_on",
    });
    expect(result.rendered).toContain("---- INBOUND ----");
    expect(result.rendered).toContain("- lessons/y.md (Y-page) via wikilink");
    expect(result.rendered).toContain(
      "- projects/z.md (Z-page) via relation:depends_on",
    );
  });

  it("--no-inbound skips the scan and emits the \"(skipped — --no-inbound)\" marker", async () => {
    await writeWikiPage("projects/x.md", {
      type: "projects",
      title: "X-page",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "Target.");
    await writeWikiPage("lessons/y.md", {
      type: "lessons",
      title: "Y-page",
      created: "2026-05-22",
      updated: "2026-05-22",
    }, "See [[projects/x]].");
    await writeWikiPage("projects/z.md", {
      type: "projects",
      title: "Z-page",
      created: "2026-05-22",
      updated: "2026-05-22",
      relations: { depends_on: ["projects/x"] },
    }, "Relation only.");

    const result = await runPage("projects/x.md", { noInbound: true });

    expect(result.inbound).toEqual([]);
    expect(result.rendered).toContain("(skipped — --no-inbound)");
  });

  async function writeWikiPage(
    relPath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const fullPath = join(root, "wiki", relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${formatYamlValue(key, value)}`)
      .join("\n");
    await writeFile(fullPath, `---\n${yaml}\n---\n${body}\n`);
  }

  function formatYamlValue(key: string, value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => formatYamlValue("", item)).join(", ")}]`;
    }
    if (value && typeof value === "object") {
      return `\n${Object.entries(value as Record<string, unknown>)
        .map(([nestedKey, nested]) => `  ${nestedKey}: ${formatYamlValue(nestedKey, nested)}`)
        .join("\n")}`;
    }
    if (
      typeof value === "string" &&
      (key === "created" || key === "updated") &&
      /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
      return value;
    }
    if (typeof value === "string") return JSON.stringify(value);
    return String(value);
  }
});
