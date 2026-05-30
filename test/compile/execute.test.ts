import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("redacts shaped secrets without redacting benign prose", async () => {
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "not-real-but-shaped-secret-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const body = [
      "Google key AIzaSyA12345678901234567890123456789012",
      "GitHub token ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "Bearer abc.def-ghi_jkl",
      "Slack token xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
      pem,
      "max_tokens: 4096",
      "the API key rotation policy",
    ].join("\n");

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/lessons/secret-shapes.md",
        frontmatter: {
          type: "lessons",
          title: "Secret Shapes",
          relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
        },
        body,
      }],
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/lessons/secret-shapes.md"]);
    const written = await readFile(join(tmp, "wiki", "lessons", "secret-shapes.md"), "utf-8");
    const parsed = parseFrontmatter(written);

    expect(parsed.body).not.toContain("AIzaSyA12345678901234567890123456789012");
    expect(parsed.body).not.toContain("ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(parsed.body).not.toContain("abc.def-ghi_jkl");
    expect(parsed.body).not.toContain("xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx");
    expect(parsed.body).not.toContain("BEGIN PRIVATE KEY");
    expect(parsed.body).not.toContain("not-real-but-shaped-secret-material");
    expect(parsed.body).toContain("Google key [REDACTED]");
    expect(parsed.body).toContain("GitHub token [REDACTED]");
    expect(parsed.body).toContain("Bearer [REDACTED]");
    expect(parsed.body).toContain("Slack token [REDACTED]");
    expect(parsed.body).toContain("max_tokens: 4096");
    expect(parsed.body).toContain("the API key rotation policy");
  });

  it("preserves grounded relation-edge objects and strips missing targets", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/lessons/relation-edges.md",
        frontmatter: {
          type: "lessons",
          title: "Relation Edges",
          relations: {
            derived_from: [
              { target: "raw/2026-05-28/a.md", confidence: 0.9 },
              { target: "raw/2026-05-28/b.md", confidence: 0.9 },
            ],
            mentions: [
              {
                target: "wiki/projects/memory-fort.md",
                confidence: 0.8,
                valid_from: "2026-05-28",
                source: { agent: "codex", session_id: "session-1" },
              },
              {
                target: "wiki/projects/missing.md",
                confidence: 0.2,
                valid_from: "2026-05-28",
              },
            ],
          },
        },
        body: "Keep relation metadata intact.",
      }],
      now: new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/lessons/relation-edges.md"]);
    expect(result.referencesStripped).toBe(1);
    const written = await readFile(join(tmp, "wiki", "lessons", "relation-edges.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.relations).toEqual({
      derived_from: [
        { target: "raw/2026-05-28/a.md", confidence: 0.9 },
        { target: "raw/2026-05-28/b.md", confidence: 0.9 },
      ],
      mentions: [
        {
          target: "wiki/projects/memory-fort.md",
          confidence: 0.8,
          valid_from: "2026-05-28",
          source: { agent: "codex", session_id: "session-1" },
        },
      ],
    });
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

  it("converts write_page on an existing path into a dated append", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          type: "projects",
          title: "Memory Fort",
          relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
        },
        body: "New compile detail for an existing page.",
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/memory-fort.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "appended",
      converted: "write->append: target already existed",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.body).toContain("Memory Fort body.");
    expect(parsed.body).toContain("## 2026-05-30 update");
    expect(parsed.body).toContain("New compile detail for an existing page.");
  });

  it("stages low-confidence converted write_page operations instead of applying them", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "write_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          type: "projects",
          title: "Memory Fort",
          relations: { derived_from: ["raw/2026-05-28/a.md"] },
        },
        body: "Thin existing-page update.",
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-fort.md"]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "staged-for-review",
      reason: "low confidence",
      converted: "write->append: target already existed",
      contentPreserved: true,
    });
    const canonical = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    expect(canonical).not.toContain("Thin existing-page update.");
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "memory-fort.md"), "utf-8");
    expect(proposal).toContain('"kind": "append_page"');
    expect(proposal).toContain('"section": "## 2026-05-30 update');
    expect(proposal).toContain("Thin existing-page update.");
  });

  it("creates a missing normalized page from append_page and preserves the section", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "append_page",
        path: "wiki/projects/iAqar.md",
        section: "iAqar is a real-estate project.\n\nRelations: raw observations mention marketplace work.",
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/iaqar.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/iaqar.md",
      outcome: "staged-for-review",
      reason: "append->create: low confidence",
      contentPreserved: true,
    });
    expect(existsSync(join(tmp, "wiki", "projects", "iAqar.md"))).toBe(false);
    expect(existsSync(join(tmp, "wiki", "projects", "iaqar.md"))).toBe(false);
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "iaqar.md"), "utf-8");
    expect(proposal).toContain('"kind": "write_page"');
    expect(proposal).toContain('"path": "wiki/projects/iaqar.md"');
    expect(proposal).toContain("iAqar is a real-estate project.");
  });

  it("normalizes only wiki page slugs and keeps index and log paths unchanged", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "write_page",
          path: "wiki/projects/VeriTrace.md",
          frontmatter: {
            type: "projects",
            title: "VeriTrace",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "VeriTrace project notes.",
        },
        { kind: "update_index", entries: ["- [VeriTrace](wiki/projects/veritrace.md) - Project."] },
        { kind: "append_log", line: "## [2026-05-30T12:00:00.000Z] compile | verified" },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/veritrace.md", "index.md", "log.md"]);
    const projectFiles = await readdir(join(tmp, "wiki", "projects"));
    expect(projectFiles).not.toContain("VeriTrace.md");
    expect(projectFiles).toContain("veritrace.md");
    await expect(readFile(join(tmp, "index.md"), "utf-8")).resolves.toContain("wiki/projects/veritrace.md");
    await expect(readFile(join(tmp, "log.md"), "utf-8")).resolves.toContain("compile | verified");
  });

  it("merges write and append operations for the same normalized missing page into one create", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "write_page",
          path: "wiki/projects/iAqar.md",
          frontmatter: {
            type: "projects",
            title: "iAqar",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "iAqar summary.",
        },
        {
          kind: "append_page",
          path: "wiki/projects/iaqar.md",
          section: "## 2026-05-30\n\nAdditional marketplace details.",
        },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/iaqar.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/iaqar.md",
      outcome: "merged",
      reason: "merged append_page into write_page",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "iaqar.md"), "utf-8");
    expect(written).toContain("iAqar summary.");
    expect(written).toContain("Additional marketplace details.");
  });

  it("preserves append content when the model emits append before write for a missing page", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "append_page",
          path: "wiki/projects/iAqar.md",
          section: "## 2026-05-30\n\nAdditional marketplace details.",
        },
        {
          kind: "write_page",
          path: "wiki/projects/iaqar.md",
          frontmatter: {
            title: "iAqar",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "iAqar summary.",
        },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/iaqar.md"]);
    expect(result.proposed).toEqual([]);
    expect(result.rejected).toEqual([]);
    const written = await readFile(join(tmp, "wiki", "projects", "iaqar.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.type).toBe("projects");
    expect(parsed.body).toContain("iAqar summary.");
    expect(parsed.body).toContain("Additional marketplace details.");
  });

  it("reports structured outcomes for appended, staged, and rejected operations", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        { kind: "append_page", path: "wiki/projects/memory-fort.md", section: "## 2026-05-30\n\nCompile outcome detail." },
        { kind: "append_page", path: "wiki/unknowns/bad.md", section: "Unknown category." },
        {
          kind: "write_page",
          path: "wiki/lessons/thin-outcome.md",
          frontmatter: {
            type: "lessons",
            title: "Thin Outcome",
            relations: { derived_from: ["raw/2026-05-28/a.md"] },
          },
          body: "Only one source, so stage it.",
        },
        { kind: "append_log", line: "## [2026-05-30T12:00:00.000Z] compile | outcomes" },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      { path: "wiki/projects/memory-fort.md", outcome: "appended", contentPreserved: true },
      {
        path: "wiki/unknowns/bad.md",
        outcome: "rejected",
        reason: "unknown wiki page category: unknowns",
        contentPreserved: false,
      },
      {
        path: "wiki/lessons/thin-outcome.md",
        outcome: "staged-for-review",
        reason: "low confidence",
        contentPreserved: true,
      },
      { path: "log.md", outcome: "log-appended", contentPreserved: true },
    ]));
    expect(result.rejected).toEqual([{ path: "wiki/unknowns/bad.md", reason: "unknown wiki page category: unknowns" }]);
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
