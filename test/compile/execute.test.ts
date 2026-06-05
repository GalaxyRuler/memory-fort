import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCompileOperations,
  isKnowledgePageType,
  parseCompileOperationsBlock,
} from "../../src/compile/execute.js";
import type { LLMProvider } from "../../src/llm/types.js";
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

  it("classifies only durable knowledge page types as rewrite-only", () => {
    expect(isKnowledgePageType("projects")).toBe(true);
    expect(isKnowledgePageType("lessons")).toBe(true);
    expect(isKnowledgePageType("issues")).toBe(true);
    expect(isKnowledgePageType("decisions")).toBe(true);
    expect(isKnowledgePageType("references")).toBe(true);
    expect(isKnowledgePageType("tools")).toBe(true);
    expect(isKnowledgePageType("people")).toBe(true);
    expect(isKnowledgePageType("prospective")).toBe(true);
    expect(isKnowledgePageType("procedures")).toBe(true);
    expect(isKnowledgePageType("threads")).toBe(false);
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

  it("stages write_page on an existing prose page instead of converting it into an append", async () => {
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

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-fort.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "staged-for-review",
      reason: "knowledge-page update requires rewrite LLM",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.body).toContain("Memory Fort body.");
    expect(parsed.body).not.toContain("New compile detail for an existing page.");
  });

  it("stages low-confidence write_page operations on existing prose pages with rewrite steering", async () => {
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
      reason: "knowledge-page update requires rewrite LLM",
      contentPreserved: true,
    });
    const canonical = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    expect(canonical).not.toContain("Thin existing-page update.");
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "memory-fort.md"), "utf-8");
    expect(proposal).toContain('"kind": "write_page"');
    expect(proposal).toContain("Thin existing-page update.");
  });

  it("skips converted write_page operations when the generated body is already present", async () => {
    const before = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const llm = fakeNoveltyLLM(() => ({ hasNewFacts: false, body: null }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      operations: [{
        kind: "write_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          type: "projects",
          title: "Memory Fort",
          relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
        },
        body: "Memory Fort body.",
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/memory-fort.md"]);
    expect(result.proposed).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      contentPreserved: true,
    });
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.toBe(before);
  });

  it("stages existing-page write_page operations that would otherwise become nested appends", async () => {
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
        body: [
          "Memory Fort body.",
          "",
          "## 2026-05-30 update",
          "",
          "Only this sentence is new.",
        ].join("\n"),
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-fort.md"]);
    const written = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.body.match(/Memory Fort body\./g)).toHaveLength(1);
    expect(parsed.body).not.toContain("Only this sentence is new.");
  });

  it("rewrites an existing page coherently and archives the prior version", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "rewrite_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          type: "projects",
          title: "Memory Fort",
          relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
        },
        body: [
          "Memory Fort body.",
          "",
          "Memory Fort now curates recurring observations into one coherent project article.",
        ].join("\n"),
      }],
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/memory-fort.md"]);
    expect(result.proposed).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      contentPreserved: true,
    });
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"));
    expect(written.body).toContain("Memory Fort body.");
    expect(written.body).toContain("one coherent project article");
    const archived = await readFile(
      join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"),
      "utf-8",
    );
    expect(parseFrontmatter(archived).body).toContain("Memory Fort body.");
  });

  it("applies shrinking rewrites when salient fact anchors are preserved", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      [
        "Memory Fort body keeps fact alpha.",
        "It also keeps fact beta.",
        "It also keeps fact gamma.",
        "It also keeps fact delta.",
      ].join("\n"),
    ));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "rewrite_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          type: "projects",
          title: "Memory Fort",
          relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
        },
        body: "Memory Fort body keeps fact alpha.",
      }],
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/memory-fort.md"]);
    expect(result.proposed).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      contentPreserved: true,
    });
    const canonical = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"));
    expect(canonical.body).toContain("fact alpha");
    expect(canonical.body).not.toContain("fact delta");
    const archived = await readFile(
      join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"),
      "utf-8",
    );
    expect(parseFrontmatter(archived).body).toContain("fact delta");
  });

  it("applies a shorter rewrite when salient relation and link anchors are preserved", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      [
        "Memory Fort integrates with [[tools/codex]] and stores durable memory for Codex Desktop.",
        "",
        "## 2026-05-30 update",
        "",
        "Memory Fort integrates with [[tools/codex]]. Codex Desktop uses Memory Fort.",
        "",
        "## 2026-05-31 update",
        "",
        "Memory Fort integrates with [[tools/codex]]. Codex Desktop uses Memory Fort.",
      ].join("\n"),
    ));
    await writeFileAt("wiki/tools/codex.md", page("tools", "Codex", "Codex Desktop."));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "rewrite_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: {
          confidence: 0.9,
          relations: { uses: ["wiki/tools/codex.md"] },
        },
        body: "Memory Fort integrates with [[tools/codex]] and stores durable memory for Codex Desktop.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      contentPreserved: true,
    });
    expect(result.proposed).toEqual([]);
    expect(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .toContain("Memory Fort integrates with [[tools/codex]]");
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"))).toBe(true);
  });

  it("stages a rewrite that drops a prior relation anchor", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", [
      "---",
      "type: projects",
      "title: Memory Fort",
      "relations:",
      "  uses:",
      "    - wiki/tools/codex.md",
      "---",
      "",
      "Memory Fort uses Codex Desktop.",
      "",
    ].join("\n"));
    await writeFileAt("wiki/tools/codex.md", page("tools", "Codex", "Codex Desktop."));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "rewrite_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: { confidence: 0.9, relations: {} },
        body: "Memory Fort stores durable memory.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "staged-for-review",
      reason: "rewrite drops salient anchors - review for content loss",
      contentPreserved: true,
    });
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-fort.md"]);
  });

  it("stages write_page and non-event append_page updates against existing prose pages", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort stores durable memory.",
    ));

    const writeResult = await applyCompileOperations({
      vaultRoot: tmp,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "write_page",
        path: "wiki/projects/memory-fort.md",
        frontmatter: { type: "projects", title: "Memory Fort" },
        body: "Memory Fort now has an additional fact.",
      }],
    });
    const appendResult = await applyCompileOperations({
      vaultRoot: tmp,
      now: new Date("2026-05-31T12:00:01.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: "Memory Fort gets another undated fact.",
      }],
    });

    for (const result of [writeResult, appendResult]) {
      expect(result.outcomes).toContainEqual({
        path: "wiki/projects/memory-fort.md",
        outcome: "staged-for-review",
        reason: "knowledge-page update requires rewrite LLM",
        contentPreserved: true,
      });
    }
    const canonical = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    expect(canonical).toContain("Memory Fort stores durable memory.");
    expect(canonical).not.toContain("additional fact");
    expect(canonical).not.toContain("undated fact");
  });

  it("uses LLM novelty judgment to update rich existing knowledge pages with genuinely new facts", async () => {
    await writeFileAt("wiki/projects/memory-system.md", page(
      "projects",
      "Memory System",
      [
        "Memory System captures raw observations and compiles them into curated wiki pages.",
        "The compile workflow uses Memory System raw files, wiki pages, and dashboard summaries.",
        "Phase 3 retrieval is planned.",
      ].join("\n"),
    ));
    const llm = fakeNoveltyLLM(() => ({
      hasNewFacts: true,
      body: [
        "Memory System captures raw observations and compiles them into curated wiki pages.",
        "The compile workflow uses Memory System raw files, wiki pages, and dashboard summaries.",
        "Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion.",
      ].join("\n"),
    }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-system.md",
        section: "## 2026-05-31 update\n\nMemory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-system.md",
      outcome: "rewritten",
      contentPreserved: true,
    });
    expect(result.pagesUpdated).toBe(1);
    expect(result.pagesUnchanged).toBe(0);
    expect(llm.calls).toBe(2);
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.frontmatter.updated).toBe("2026-05-31");
    expect(written.body).toContain("Phase 3 retrieval shipped");
    expect(written.body).not.toMatch(/^##\s+2026-05-31/m);
  });

  it("extracts facts before knowledge-page novelty when requested", async () => {
    await writeFileAt("wiki/projects/memory-system.md", page(
      "projects",
      "Memory System",
      [
        "Memory System captures raw observations and compiles them into curated wiki pages.",
        "Phase 3 retrieval is planned.",
      ].join("\n"),
    ));
    const llm = fakeExtractionAndNoveltyLLM({
      facts: ["Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion."],
      body: [
        "Memory System captures raw observations and compiles them into curated wiki pages.",
        "Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion.",
      ].join("\n"),
    });

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      extractFacts: true,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-system.md",
        section: [
          "## 2026-05-31 update",
          "",
          "Raw transcript: SEARCH RESULT CARD COPY SHOULD NOT ENTER THE PAGE.",
          "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
        ].join("\n"),
      }],
    });

    expect(result.outcomes.at(-1)?.outcome).toBe("rewritten");
    expect(result.sessionsScanned).toBe(1);
    expect(result.factsExtracted).toBe(1);
    expect(result.extractionTokensUsed?.total).toBe(28);
    expect(llm.calls).toBe(3);
    expect(llm.noveltyPrompts[0]).toContain("Memory System shipped Phase 3 retrieval");
    expect(llm.noveltyPrompts[0]).not.toContain("SEARCH RESULT CARD COPY");
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.body).toContain("Phase 3 retrieval shipped");
    expect(written.body).not.toContain("SEARCH RESULT CARD COPY");
  });

  it("rewrites dated append_page updates against existing knowledge pages", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort stores durable memory.",
    ));
    const llm = fakeNoveltyLLM(({ currentBody, newContent }) => ({
      hasNewFacts: true,
      body: [
        currentBody.trim(),
        stripMarkdownHeading(newContent).trim(),
      ].join("\n\n"),
    }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: "## 2026-05-31 update\n\nMemory Fort had a dated operator event.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      contentPreserved: true,
    });
    expect(result.pagesRewritten).toBe(1);
    expect(result.pagesUpdated).toBe(1);
    expect(result.pagesUnchanged).toBe(0);
    expect(llm.calls).toBe(2);
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"));
    expect(written.body).toContain("Memory Fort stores durable memory.");
    expect(written.body).toContain("Memory Fort had a dated operator event.");
    expect(written.body).not.toMatch(/^##\s+2026-05-31/m);
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"))).toBe(true);
  });

  it("stages knowledge-page updates when no rewrite LLM is available", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort stores durable memory.",
    ));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: "## 2026-05-31 update\n\nMemory Fort had a dated operator event.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "staged-for-review",
      reason: "knowledge-page update requires rewrite LLM",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    expect(written).not.toContain("dated operator event");
  });

  it("skips knowledge-page rewrites when incoming content is already covered", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort captures raw observations and keeps long-term memory available.",
    ));
    const before = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const llm = fakeNoveltyLLM(() => ({
      hasNewFacts: false,
      body: null,
    }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: "## 2026-05-31 update\n\nMemory Fort captures raw observations and keeps long-term memory available.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      contentPreserved: true,
    });
    expect(result.pagesRewritten).toBe(0);
    expect(result.pagesUpdated).toBe(0);
    expect(result.pagesUnchanged).toBe(1);
    expect(llm.calls).toBe(1);
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.toBe(before);
    expect(existsSync(join(tmp, "wiki", ".history"))).toBe(false);
  });

  it("skips cosmetic-only novelty rewrites without archiving", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort stores durable memory.\nMemory Fort records compile observations.",
    ));
    const before = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const llm = fakeNoveltyLLM(() => ({
      hasNewFacts: true,
      body: "  Memory Fort stores durable memory.  \n\nMemory Fort records compile observations.\n",
    }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      now: new Date("2026-05-31T12:00:00.000Z"),
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: "## 2026-05-31 update\n\nMemory Fort stores durable memory and records compile observations.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      contentPreserved: true,
    });
    expect(result.pagesUpdated).toBe(0);
    expect(result.pagesUnchanged).toBe(1);
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.toBe(before);
    expect(existsSync(join(tmp, "wiki", ".history"))).toBe(false);
  });

  it("still appends dated updates to thread pages", async () => {
    await writeFileAt("wiki/threads/compile-thread.md", page(
      "threads",
      "Compile Thread",
      "Compile thread opened.",
    ));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "append_page",
        path: "wiki/threads/compile-thread.md",
        section: "## 2026-05-31 update\n\nCompile thread recorded a chronological event.",
      }],
    });

    expect(result.outcomes).toContainEqual({
      path: "wiki/threads/compile-thread.md",
      outcome: "appended",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "threads", "compile-thread.md"), "utf-8");
    expect(written).toMatch(/^##\s+2026-05-31 update/m);
  });

  it("keeps a hot knowledge entity bounded across 30 append-emitting passes", async () => {
    await writeFileAt("wiki/projects/hot-entity.md", [
      "---",
      "type: projects",
      "title: Hot Entity",
      "relations:",
      "  uses:",
      "    - wiki/tools/codex.md",
      "---",
      "",
      "Hot Entity uses [[tools/codex]].",
      "",
    ].join("\n"));
    await writeFileAt("wiki/tools/codex.md", page("tools", "Codex", "Codex Desktop."));
    const llm = fakeNoveltyLLM(({ currentBody, newContent }) => ({
      hasNewFacts: true,
      body: [
        currentBody.trim(),
        stripMarkdownHeading(newContent).trim(),
      ].join("\n\n"),
    }));

    for (let i = 1; i <= 30; i += 1) {
      const result = await applyCompileOperations({
        vaultRoot: tmp,
        rewriteLLM: llm,
        now: new Date(`2026-05-31T12:${String(i).padStart(2, "0")}:00.000Z`),
        operations: [{
          kind: "append_page",
          path: "wiki/projects/hot-entity.md",
          section: `## 2026-05-31 update\n\nHot Entity uses [[tools/codex]] and records alpha${i} beta${i} gamma${i} delta${i}.`,
        }],
      });
      expect(result.outcomes.at(-1)?.outcome).toBe("rewritten");
    }

    const current = await readFile(join(tmp, "wiki", "projects", "hot-entity.md"), "utf-8");
    expect(current.match(/^##\s+\d{4}-\d{2}-\d{2}/gm) ?? []).toHaveLength(0);
    expect(current.match(/records alpha/g) ?? []).toHaveLength(30);
    expect(current).toContain("alpha1 beta1 gamma1 delta1");
    expect(current).toContain("alpha30 beta30 gamma30 delta30");
    const historyDir = join(tmp, "wiki", ".history", "wiki", "projects", "hot-entity.md");
    expect((await readdir(historyDir)).filter((name) => name.endsWith(".md"))).toHaveLength(30);
    expect(llm.calls).toBe(60);
  });

  it("skips append_page sections whose content is already substantially present", async () => {
    await writeFileAt("wiki/projects/memory-fort.md", page(
      "projects",
      "Memory Fort",
      "Memory Fort captures raw observations, compiles them into curated wiki pages, and keeps long-term memory available across tools.",
    ));
    const before = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    const llm = fakeNoveltyLLM(() => ({ hasNewFacts: false, body: null }));

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      rewriteLLM: llm,
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: [
          "## 2026-05-30 update",
          "",
          "Memory Fort captures raw observations and compiles them into curated wiki pages so long-term memory remains available across tools.",
        ].join("\n"),
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/memory-fort.md"]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      contentPreserved: true,
    });
    await expect(readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"))
      .resolves.toBe(before);
  });

  it("stages genuinely new knowledge-page facts when no rewrite LLM is available", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "append_page",
        path: "wiki/projects/memory-fort.md",
        section: [
          "## 2026-05-30 update",
          "",
          "Memory Fort now rebuilds its wiki index deterministically after successful compile execution.",
        ].join("\n"),
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-fort.md"]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/memory-fort.md",
      outcome: "staged-for-review",
      reason: "knowledge-page update requires rewrite LLM",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8");
    expect(written).not.toContain("rebuilds its wiki index deterministically");
  });

  it("creates a missing normalized page from append_page and preserves the section", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [{
        kind: "append_page",
        path: "wiki/projects/Acme.md",
        section: "Acme is a real-estate project.\n\nRelations: raw observations mention marketplace work.",
      }],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual([]);
    expect(result.proposed).toEqual(["wiki/compile-proposed/acme.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/acme.md",
      outcome: "staged-for-review",
      reason: "append->create: low confidence",
      contentPreserved: true,
    });
    expect(existsSync(join(tmp, "wiki", "projects", "Acme.md"))).toBe(false);
    expect(existsSync(join(tmp, "wiki", "projects", "acme.md"))).toBe(false);
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "acme.md"), "utf-8");
    expect(proposal).toContain('"kind": "write_page"');
    expect(proposal).toContain('"path": "wiki/projects/acme.md"');
    expect(proposal).toContain("Acme is a real-estate project.");
  });

  it("normalizes only wiki page slugs while update_index no-ops and log paths stay unchanged", async () => {
    await writeFileAt("index.md", "# Existing Index\n\n");

    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "write_page",
          path: "wiki/projects/TraceKit.md",
          frontmatter: {
            type: "projects",
            title: "TraceKit",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "TraceKit project notes.",
        },
        { kind: "update_index", entries: ["- [TraceKit](wiki/projects/tracekit.md) - Project."] },
        { kind: "append_log", line: "## [2026-05-30T12:00:00.000Z] compile | verified" },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/tracekit.md", "index.md", "log.md"]);
    const projectFiles = await readdir(join(tmp, "wiki", "projects"));
    expect(projectFiles).not.toContain("TraceKit.md");
    expect(projectFiles).toContain("tracekit.md");
    await expect(readFile(join(tmp, "index.md"), "utf-8")).resolves.toBe("# Existing Index\n\n");
    await expect(readFile(join(tmp, "log.md"), "utf-8")).resolves.toContain("compile | verified");
  });

  it("merges write and append operations for the same normalized missing page into one create", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "write_page",
          path: "wiki/projects/Acme.md",
          frontmatter: {
            type: "projects",
            title: "Acme",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "Acme summary.",
        },
        {
          kind: "append_page",
          path: "wiki/projects/acme.md",
          section: "## 2026-05-30\n\nAdditional marketplace details.",
        },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/acme.md"]);
    expect(result.rejected).toEqual([]);
    expect(result.outcomes).toContainEqual({
      path: "wiki/projects/acme.md",
      outcome: "merged",
      reason: "merged append_page into write_page",
      contentPreserved: true,
    });
    const written = await readFile(join(tmp, "wiki", "projects", "acme.md"), "utf-8");
    expect(written).toContain("Acme summary.");
    expect(written).toContain("Additional marketplace details.");
  });

  it("preserves append content when the model emits append before write for a missing page", async () => {
    const result = await applyCompileOperations({
      vaultRoot: tmp,
      operations: [
        {
          kind: "append_page",
          path: "wiki/projects/Acme.md",
          section: "## 2026-05-30\n\nAdditional marketplace details.",
        },
        {
          kind: "write_page",
          path: "wiki/projects/acme.md",
          frontmatter: {
            title: "Acme",
            relations: { derived_from: ["raw/2026-05-28/a.md", "raw/2026-05-28/b.md"] },
          },
          body: "Acme summary.",
        },
      ],
      now: new Date("2026-05-30T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/projects/acme.md"]);
    expect(result.proposed).toEqual([]);
    expect(result.rejected).toEqual([]);
    const written = await readFile(join(tmp, "wiki", "projects", "acme.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.frontmatter.type).toBe("projects");
    expect(parsed.body).toContain("Acme summary.");
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
      {
        path: "wiki/projects/memory-fort.md",
        outcome: "staged-for-review",
        reason: "knowledge-page update requires rewrite LLM",
        contentPreserved: true,
      },
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

function page(type: string, title: string, body = `${title} body.`): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-05-28",
    "updated: 2026-05-28",
    "---",
    "",
    body,
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

function fakeNoveltyLLM(
  judge: (input: { currentBody: string; newContent: string; prompt: string }) => { hasNewFacts: boolean; body: string | null },
): LLMProvider & { calls: number } {
  const provider: LLMProvider & { calls: number } = {
    calls: 0,
    providerName: "test",
    modelName: "rewrite-test",
    async chat(request) {
      const prompt = request.messages.map((message) => message.content).join("\n");
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        provider.calls += 1;
        const currentBody = /Current body:\n([\s\S]*?)\n\nFacts:/.exec(prompt)?.[1] ?? "";
        const newContent = /Facts:\n([\s\S]*)$/.exec(prompt)?.[1] ?? "";
        const decision = judge({ currentBody, newContent, prompt });
        return fakeLLMResponse(JSON.stringify({
          contradicted_claims: [],
          net_new_facts: decision.hasNewFacts ? [decision.body ?? newContent] : [],
        }));
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        provider.calls += 1;
        const currentBody = /Current body:\n([\s\S]*?)\n\nContradicted claims:/.exec(prompt)?.[1] ?? "";
        const newContent = acceptedFactText(/Accepted fact records:\n([\s\S]*)$/.exec(prompt)?.[1] ?? "");
        const decision = judge({ currentBody, newContent, prompt });
        return fakeLLMResponse(JSON.stringify({
          body: decision.body ?? currentBody,
        }));
      }
      provider.calls += 1;
      const currentBody = /Current page body:\n```markdown\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "";
      const newContent = /New content to integrate:\n```markdown\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "";
      return {
        model: "rewrite-test",
        rawProviderName: "test",
        finishReason: "stop",
        tokensUsed: { prompt: 10, completion: 5, total: 15 },
        content: [
          "```json",
          JSON.stringify(judge({ currentBody, newContent, prompt })),
          "```",
        ].join("\n"),
      };
    },
  };
  return provider;
}

function fakeExtractionAndNoveltyLLM(opts: {
  facts: string[];
  body: string;
}): LLMProvider & { calls: number; noveltyPrompts: string[] } {
  const provider: LLMProvider & { calls: number; noveltyPrompts: string[] } = {
    calls: 0,
    noveltyPrompts: [],
    providerName: "rewrite-test",
    modelName: "rewrite-test",
    async chat(request) {
      const system = request.messages[0]?.content ?? "";
      if (system.includes("entity fact extractor")) {
        provider.calls += 1;
        return {
          model: "rewrite-test",
          rawProviderName: "rewrite-test",
          finishReason: "stop",
          tokensUsed: { prompt: 20, completion: 8, total: 28 },
          content: [
            "```json",
            JSON.stringify({ facts: opts.facts }),
            "```",
          ].join("\n"),
        };
      }
      const prompt = request.messages.at(-1)?.content ?? "";
      provider.noveltyPrompts.push(prompt);
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        provider.calls += 1;
        return fakeLLMResponse(JSON.stringify({
          contradicted_claims: [],
          net_new_facts: opts.facts,
        }));
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        provider.calls += 1;
        return fakeLLMResponse(JSON.stringify({
          body: opts.body,
        }));
      }
      provider.calls += 1;
      return {
        model: "rewrite-test",
        rawProviderName: "rewrite-test",
        finishReason: "stop",
        tokensUsed: { prompt: 10, completion: 5, total: 15 },
        content: [
          "```json",
          JSON.stringify({ hasNewFacts: true, body: opts.body }),
          "```",
        ].join("\n"),
      };
    },
  };
  return provider;
}

function fakeLLMResponse(content: string) {
  return {
    model: "rewrite-test",
    rawProviderName: "test",
    finishReason: "stop" as const,
    tokensUsed: { prompt: 10, completion: 5, total: 15 },
    content,
  };
}

function acceptedFactText(json: string): string {
  try {
    const parsed = JSON.parse(json) as Array<{ text?: unknown }>;
    return parsed.map((item) => typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
  } catch {
    return json;
  }
}

function splitParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").trim())
    .filter(Boolean);
}

function stripMarkdownHeading(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^##\s+\d{4}-\d{2}-\d{2}/.test(line.trim()))
    .join("\n")
    .trim();
}
