import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLint } from "../../../src/cli/commands/lint.js";

const TEMPLATE = [
  "SCHEMA={{schema_content}}",
  "LOG={{recent_log_lines}}",
].join("\n");

describe("runLint", () => {
  let tmp: string;
  let root: string;
  let origMemRoot: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "lint-"));
    root = join(tmp, ".memory");
    origMemRoot = process.env["MEMORY_ROOT"];
    process.env["MEMORY_ROOT"] = root;
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await writeFile(join(root, "prompts", "lint.md"), TEMPLATE);
    await writeFile(join(root, "schema.md"), "# Schema\n\nContract details.\n");
    await writeFile(join(root, "log.md"), "# Log\n\nrecent lint context\n");
  });

  afterEach(async () => {
    if (origMemRoot === undefined) delete process.env["MEMORY_ROOT"];
    else process.env["MEMORY_ROOT"] = origMemRoot;
    await rm(tmp, { recursive: true, force: true });
  });

  it("substitutes schema and recent log context into the lint prompt", async () => {
    const result = await runLint();

    expect(result.mode).toBe("prompt");
    if (result.mode === "prompt") {
      expect(result.prompt).toContain("SCHEMA=# Schema");
      expect(result.prompt).toContain("Contract details.");
      expect(result.prompt).toContain("LOG=# Log");
      expect(result.prompt).toContain("recent lint context");
      expect(result.prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
  });

  it("reports a clean checks-only run with zero blocking issues", async () => {
    await writeWikiPage(
      "projects/a.md",
      {
        type: "projects",
        title: "A",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        confidence: 0.9,
      },
      "See [[projects/b]].",
    );
    await writeWikiPage(
      "projects/b.md",
      {
        type: "projects",
        title: "B",
        created: "2026-05-21",
        updated: "2026-05-21",
        status: "active",
        confidence: 0.9,
      },
      "See [[projects/a]].",
    );

    const result = await runLint({
      checksOnly: true,
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(result.mode).toBe("checks");
    if (result.mode === "checks") {
      expect(result.issues).toEqual([]);
      expect(result.hasBlockingIssues).toBe(false);
      expect(result.report).toContain("Total issues: 0");
      expect(result.report).toContain("No issues found.");
    }
  });

  it("marks frontmatter and broken-relation issues as blocking", async () => {
    await writeWikiPage(
      "projects/a.md",
      {
        type: "projects",
        created: "2026-05-21",
        updated: "2026-05-21",
        relations: { uses: ["ghost"] },
      },
      "Problem page.",
    );

    const result = await runLint({
      checksOnly: true,
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(result.mode).toBe("checks");
    if (result.mode === "checks") {
      expect(result.hasBlockingIssues).toBe(true);
      expect(result.counts["frontmatter"]).toBeGreaterThan(0);
      expect(result.counts["broken-relation"]).toBe(1);
      expect(result.report).toContain("Blocking issues: yes");
      expect(result.report).toContain("wiki/projects/a.md");
      expect(result.report).toContain("ghost");
    }
  });

  it("does not mark orphan, stale, or draft issues as blocking", async () => {
    await writeWikiPage(
      "projects/a.md",
      {
        type: "projects",
        title: "A",
        created: "2025-01-01",
        updated: "2025-01-01",
        status: "active",
        confidence: 0.3,
      },
      "No inbound references.",
    );

    const result = await runLint({
      checksOnly: true,
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(result.mode).toBe("checks");
    if (result.mode === "checks") {
      expect(result.hasBlockingIssues).toBe(false);
      expect(result.counts["orphan"]).toBe(1);
      expect(result.counts["stale"]).toBe(1);
      expect(result.counts["draft"]).toBe(1);
      expect(result.report).toContain("[orphan]");
      expect(result.report).toContain("[stale]");
      expect(result.report).toContain("[draft]");
    }
  });

  it("passes staleDays through to programmatic checks", async () => {
    await writeWikiPage(
      "projects/a.md",
      {
        type: "projects",
        title: "A",
        created: "2026-05-01",
        updated: "2026-05-01",
        status: "active",
      },
      "No stale at a longer threshold.",
    );

    const stale = await runLint({
      checksOnly: true,
      staleDays: 10,
      now: new Date("2026-05-22T00:00:00.000Z"),
    });
    const fresh = await runLint({
      checksOnly: true,
      staleDays: 30,
      now: new Date("2026-05-22T00:00:00.000Z"),
    });

    expect(stale.mode).toBe("checks");
    expect(fresh.mode).toBe("checks");
    if (stale.mode === "checks" && fresh.mode === "checks") {
      expect(stale.counts["stale"]).toBe(1);
      expect(fresh.counts["stale"]).toBe(0);
    }
  });

  async function writeWikiPage(
    relPath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void> {
    const full = join(root, "wiki", relPath);
    await mkdir(dirname(full), { recursive: true });
    const yaml = Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${formatYamlValue(value)}`)
      .join("\n");
    await writeFile(full, `---\n${yaml}\n---\n${body}\n`);
  }

  function formatYamlValue(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(formatYamlValue).join(", ")}]`;
    if (value && typeof value === "object") {
      return `\n${Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => `  ${key}: ${formatYamlValue(nested)}`)
        .join("\n")}`;
    }
    if (typeof value === "string") return JSON.stringify(value);
    return String(value);
  }
});
