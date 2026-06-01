import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrateToNarrative } from "../../../src/cli/commands/migrate-to-narrative.js";
import { parseCompileOperationBlock } from "../../../src/compile/execute.js";
import { parseFrontmatter, serializeFrontmatter } from "../../../src/storage/frontmatter.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../../src/llm/types.js";

describe("runMigrateToNarrative", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "migrate-narrative-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("plans and applies one-time narrative migration with code-owned frontmatter", async () => {
    await writePage("wiki/projects/memory-system.md", [
      "## Status",
      "",
      "- Memory System captures raw observations.",
      "- [[docs/ROADMAP]] tracks rollout decisions.",
      "",
    ].join("\n"));

    const plan = await runMigrateToNarrative({
      vaultRoot: tmp,
      mode: "plan",
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(plan.candidates).toEqual(["wiki/projects/memory-system.md"]);
    expect(plan.report).toContain("Candidates: 1");

    const llm = fakeMigrationLLM("Memory System captures raw observations, and [[docs/ROADMAP]] tracks rollout decisions.");
    const applied = await runMigrateToNarrative({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-06-01T00:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "openrouter" } }),
      llmFactory: () => llm,
    });

    expect(applied.migrated).toEqual(["wiki/projects/memory-system.md"]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const request = vi.mocked(llm.chat).mock.calls[0]![0];
    expect(request.messages[0]!.content).toContain("You are a memory consolidation engine.");
    expect(request.messages[1]!.content).toContain("contradicted_claims:\n[]");
    expect(request.messages[1]!.content).toContain("- Memory System captures raw observations.");

    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.body).not.toMatch(/^##\s/m);
    expect(written.body).not.toMatch(/^\s*[-*+]\s/m);
    expect(written.body).toContain("[[docs/ROADMAP]]");
    expect(written.frontmatter.version).toBe(2);
    expect(written.frontmatter.updated).toBe("2026-06-01");
    expect(written.frontmatter.last_accessed).toBe("2026-06-01");
    expect(written.frontmatter.source_facts).toEqual([]);
    expect(written.frontmatter.supersedes).toEqual([
      expect.objectContaining({
        path: "wiki/.history/wiki/projects/memory-system.md/2026-06-01T00-00-00-000Z.md",
        version: 1,
      }),
    ]);
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T00-00-00-000Z.md"))).toBe(true);
  });

  it("stages safety-gate failures as promotable compile proposals", async () => {
    await writePage("wiki/lessons/engineering-process-lessons.md", [
      "## Process",
      "",
      "- [[agentmemory-consolidation-architecture]] should be checked before redesigning consolidation.",
      "",
    ].join("\n"));

    const llm = fakeMigrationLLM("Prior art should be checked before redesigning consolidation.");
    const applied = await runMigrateToNarrative({
      vaultRoot: tmp,
      mode: "apply",
      now: new Date("2026-06-01T00:00:00.000Z"),
      configLoader: async () => ({ llm: { provider: "openrouter" } }),
      llmFactory: () => llm,
    });

    expect(applied.staged).toEqual(["wiki/lessons/engineering-process-lessons.md"]);
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "engineering-process-lessons.md"), "utf-8");
    const parsed = parseCompileOperationBlock(proposal);
    expect(parsed).toEqual({
      ok: true,
      operation: {
        kind: "rewrite_page",
        path: "wiki/lessons/engineering-process-lessons.md",
        frontmatter: {},
        body: "Prior art should be checked before redesigning consolidation.",
      },
    });
    expect(proposal).toContain("Reason: migration safety gate failed");
  });

  async function writePage(relPath: string, body: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, serializeFrontmatter({
      type: "projects",
      title: "Memory System",
      created: "2026-05-30",
      updated: "2026-05-30",
      version: 1,
    }, body), "utf-8");
  }
});

function fakeMigrationLLM(body: string): LLMProvider {
  const chat = vi.fn(async (_request: LLMRequest): Promise<LLMResponse> => ({
    model: "test",
    finishReason: "stop",
    rawProviderName: "test",
    tokensUsed: { prompt: 20, completion: 10, total: 30 },
    content: JSON.stringify({ body }),
  }));
  return { providerName: "test", modelName: "test", chat };
}
