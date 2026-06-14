import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCompile } from "../../../src/cli/commands/compile.js";
import {
  applyCompileOperations,
  parseCompileOperationsBlock,
} from "../../../src/compile/execute.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

const TEMPLATE = [
  "# memory:custom",
  "SCHEMA={{schema_content}}",
  "INDEX={{index_content}}",
  "EXISTING={{existing_pages}}",
  "LOG={{recent_log_lines}}",
  "FILES={{raw_files_list}}",
  "RAW={{raw_content}}",
].join("\n");

describe("compile core memory extraction", () => {
  let tmp: string;
  let root: string;
  let origMemRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "compile-core-"));
    root = join(tmp, ".memory");
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "raw", "2026-06-01"), { recursive: true });
    await mkdir(join(root, "wiki", "preferences"), { recursive: true });
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await writeFile(join(root, "prompts", "compile.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n");
    await writeFile(join(root, "index.md"), "# Index\n");
    await writeFile(join(root, "log.md"), "# Log\n");
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("executor applies a core memory write_page from a simulated LLM response", async () => {
    const llmResponse = JSON.stringify({
      operations: [
        {
          kind: "write_page",
          path: "wiki/preferences/never-mock-database.md",
          frontmatter: {
            type: "preferences",
            title: "Never Mock Database",
            cognitive_type: "core",
            source: "compile-execute",
            confidence: 0.9,
            tags: ["preference", "constraint"],
            relations: {
              derived_from: ["raw/2026-06-01/claude-code-session.md"],
            },
          },
          body: "Do not mock the database in integration tests. Use a real database connection with test fixtures.",
        },
        {
          kind: "append_log",
          line: "## [2026-06-01T12:00:00.000Z] compile | 1 raw -> 0 updates, 1 new page",
        },
      ],
    });

    const parsed = parseCompileOperationsBlock(
      "```compile-ops\n" + llmResponse + "\n```",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const result = await applyCompileOperations({
      vaultRoot: root,
      operations: parsed.operations,
    });

    expect(result.rejected).toEqual([]);
    expect(result.applied).toContain("wiki/preferences/never-mock-database.md");

    const pagePath = join(root, "wiki", "preferences", "never-mock-database.md");
    expect(existsSync(pagePath)).toBe(true);

    const content = await readFile(pagePath, "utf-8");
    const fm = parseFrontmatter(content);
    expect(fm.frontmatter.type).toBe("preferences");
    expect(fm.frontmatter.cognitive_type).toBe("core");
    expect(fm.frontmatter.source).toBe("compile-execute");
    expect(fm.frontmatter.confidence).toBe(0.9);
    expect(fm.body).toContain("Do not mock the database");
  });

  it("executor applies rewrite_page on an existing preference page", async () => {
    const existingPage = join(root, "wiki", "preferences", "use-tabs.md");
    await writeFile(
      existingPage,
      [
        "---",
        "type: preferences",
        "title: Use Tabs",
        "created: 2026-05-01",
        "updated: 2026-05-01",
        "cognitive_type: core",
        "source: compile-execute",
        "confidence: 0.7",
        "---",
        "",
        "Always use tabs for indentation.",
      ].join("\n"),
    );

    const result = await applyCompileOperations({
      vaultRoot: root,
      operations: [
        {
          kind: "rewrite_page",
          path: "wiki/preferences/use-tabs.md",
          frontmatter: {
            type: "preferences",
            title: "Use Tabs",
            cognitive_type: "core",
            source: "compile-execute",
            confidence: 0.9,
          },
          body: "Always use tabs for indentation. Tab width should be 2 spaces equivalent.",
        },
      ],
    });

    expect(result.rejected).toEqual([]);
    const content = await readFile(existingPage, "utf-8");
    const fm = parseFrontmatter(content);
    expect(fm.frontmatter.confidence).toBe(0.9);
    expect(fm.body).toContain("Tab width should be 2 spaces equivalent");
  });

  it("includes a raw observation directive in the rendered compile prompt", async () => {
    await writeFile(
      join(root, "raw", "2026-06-01", "claude-code-session.md"),
      [
        "## [12:00:00] Prompt",
        "",
        "From now on, always run tests before pushing. Never skip the test suite.",
        "",
        "## [12:05:00] Response",
        "",
        "Understood. I will always run the full test suite before any push.",
      ].join("\n"),
    );

    const result = await runCompile({ vaultRoot: root });

    expect(result.prompt).toContain("always run tests before pushing");
    expect(result.prompt).toContain("Never skip the test suite");
    expect(result.rawFilesIncluded.length).toBe(1);
  });
});
