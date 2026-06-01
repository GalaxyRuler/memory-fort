import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCurate } from "../../../src/cli/commands/curate.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { parseFrontmatter } from "../../../src/storage/frontmatter.js";

describe("runCurate", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "curate-"));
    await writeFileAt("schema.md", "# Schema\n");
    await writeFileAt("wiki/projects/memory-fort.md", page([
      "Memory Fort stores durable memory.",
      "",
      "## 2026-05-30 update",
      "",
      "Memory Fort records compile observations.",
      "",
      "## 2026-05-31 update",
      "",
      "Memory Fort records compile observations.",
      "Memory Fort now supports curate-merge consolidation.",
    ].join("\n")));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("applies a non-shrinking curated rewrite and is idempotent on re-run", async () => {
    const llm = fakeCurateLLM([
      "Memory Fort stores durable memory and records compile observations.",
      "",
      "It now supports curate-merge consolidation.",
    ].join("\n"));

    const first = await runCurate({
      vaultRoot: tmp,
      target: "wiki/projects/memory-fort.md",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });
    const second = await runCurate({
      vaultRoot: tmp,
      target: "wiki/projects/memory-fort.md",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:01.000Z"),
    });

    expect(first.pages).toEqual([{
      path: "wiki/projects/memory-fort.md",
      outcome: "rewritten",
      proposed: false,
    }]);
    expect(second.pages).toEqual([{
      path: "wiki/projects/memory-fort.md",
      outcome: "skipped: no new content",
      proposed: false,
    }]);
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-fort.md"), "utf-8"));
    expect(written.body.match(/^## 2026-/gm) ?? []).toHaveLength(0);
    expect(written.body).toContain("stores durable memory");
    expect(written.body).toContain("compile observations");
    expect(written.body).toContain("curate-merge consolidation");
    expect(existsSync(join(tmp, "wiki", ".history", "wiki", "projects", "memory-fort.md", "2026-05-31T12-00-00-000Z.md"))).toBe(true);
  });

  it("resolves a bare page slug across wiki categories", async () => {
    await writeFileAt("wiki/projects/agentmemory.md", page("AgentMemory keeps imported memory."));
    const llm = fakeCurateLLM("AgentMemory keeps imported memory in one coherent article.");

    const result = await runCurate({
      vaultRoot: tmp,
      target: "agentmemory",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.pages).toEqual([{
      path: "wiki/projects/agentmemory.md",
      outcome: "rewritten",
      proposed: false,
    }]);
  });

  it("refresh uses stored page-scoped facts before novelty judgment and ignores raw tangents", async () => {
    await writeFileAt("wiki/projects/memory-system.md", [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-05-22",
      "updated: 2026-05-22",
      "---",
      "",
      "Memory System captures raw observations.",
      "Phase 3 retrieval is planned.",
      "",
    ].join("\n"));
    await writeFileAt("raw/2026-05-31/session.md", [
      "## [2026-05-31 10:00:00] codex | observation",
      "",
      "SEARCH RESULT CARD COPY SHOULD NOT ENTER THE MEMORY SYSTEM PAGE.",
    ].join("\n"));
    await writeFact("facts/2026-05-31/session.json", [
      "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      "Memory System dashboard added manual compile execution and staged inbox links.",
    ]);
    const llm = fakeRefreshPipelineLLM({
      facts: [
        "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
        "Memory System dashboard added manual compile execution and staged inbox links.",
      ],
      body: [
        "Memory System captures raw observations.",
        "Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion.",
        "The dashboard added manual compile execution and staged inbox links.",
      ].join("\n"),
    });

    const result = await runCurate({
      vaultRoot: tmp,
      target: "memory-system",
      refresh: true,
      apply: true,
      refreshDays: 36500,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.pages).toEqual([{
      path: "wiki/projects/memory-system.md",
      outcome: "rewritten",
      proposed: false,
    }]);
    expect(llm.chat).toHaveBeenCalledTimes(2);
    const noveltyPrompt = vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content;
    expect(noveltyPrompt).toContain("Memory System shipped Phase 3 retrieval");
    expect(noveltyPrompt).not.toContain("SEARCH RESULT CARD COPY");
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.frontmatter.updated).toBe("2026-05-31");
    expect(written.body).toContain("Phase 3 retrieval shipped");
    expect(written.body).toContain("manual compile execution");
    expect(written.body).not.toContain("SEARCH RESULT CARD COPY");
    expect(written.body).not.toMatch(/^##\s+Refresh observations/m);
  });

  it("refresh reuses stored facts on a no-new-facts rerun", async () => {
    await writeFileAt("wiki/projects/memory-system.md", [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-05-22",
      "updated: 2026-05-22",
      "---",
      "",
      "Memory System captures raw observations.",
      "Phase 3 retrieval is planned.",
      "",
    ].join("\n"));
    await writeFact("facts/2026-05-31/session.json", [
      "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
    ]);
    const llm = fakeRefreshPipelineLLM({
      facts: ["Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion."],
      body: [
        "Memory System captures raw observations.",
        "Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion.",
      ].join("\n"),
      secondNovelty: { hasNewFacts: false, body: null },
    });

    const first = await runCurate({
      vaultRoot: tmp,
      target: "memory-system",
      refresh: true,
      apply: true,
      refreshDays: 36500,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:00:00.000Z"),
    });
    const second = await runCurate({
      vaultRoot: tmp,
      target: "memory-system",
      refresh: true,
      apply: true,
      refreshDays: 36500,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => llm,
      env: {},
      now: new Date("2026-05-31T12:01:00.000Z"),
    });

    expect(first.pages[0]?.outcome).toBe("rewritten");
    expect(second.pages[0]?.outcome).toBe("skipped: no new content");
    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(vi.mocked(llm.chat).mock.calls.filter((call) => call[0].messages[0]?.content.includes("entity fact extractor"))).toHaveLength(0);
    const historyDir = join(tmp, "wiki", ".history", "wiki", "projects", "memory-system.md");
    expect((await readdir(historyDir)).filter((name) => name.endsWith(".md"))).toHaveLength(1);
  });

  it("reports ambiguity when a bare page slug exists in multiple categories", async () => {
    await writeFileAt("wiki/projects/iaqar.md", page("iAqar project."));
    await writeFileAt("wiki/tools/iaqar.md", page("iAqar tool."));

    await expect(runCurate({
      vaultRoot: tmp,
      target: "iaqar",
      apply: true,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeCurateLLM("unused"),
      env: {},
    })).rejects.toThrow("matches: wiki/projects/iaqar.md, wiki/tools/iaqar.md");
  });

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async function writeFact(relPath: string, facts: string[]): Promise<void> {
    await writeFileAt(relPath, `${JSON.stringify({
      version: 1,
      sourceRawPath: "raw/2026-05-31/session.md",
      sessionId: "session",
      observedAt: "2026-05-31T10:00:00.000Z",
      compressedAt: "2026-05-31T12:00:00.000Z",
      facts: [{
        title: "Memory System refresh facts",
        facts,
        narrative: facts.join(" "),
        concepts: ["Memory System"],
        files: [],
        importance: 8,
        sessionId: "session",
        sourceRawPath: "raw/2026-05-31/session.md",
        observedAt: "2026-05-31T10:00:00.000Z",
        compressedAt: "2026-05-31T12:00:00.000Z",
      }],
    }, null, 2)}\n`);
  }
});

function page(body: string): string {
  return [
    "---",
    "type: projects",
    "title: Memory Fort",
    "created: 2026-05-30",
    "updated: 2026-05-30",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function fakeCurateLLM(body: string): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      content: [
        "```compile-op",
        JSON.stringify({
          kind: "rewrite_page",
          path: "wiki/projects/memory-fort.md",
          frontmatter: { title: "Memory Fort", confidence: 0.9 },
          body,
        }),
        "```",
      ].join("\n"),
    })),
  };
}

function fakeNoveltyLLM(decision: { hasNewFacts: boolean; body: string | null }): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      content: [
        "```json",
        JSON.stringify(decision),
        "```",
      ].join("\n"),
    })),
  };
}

function fakeRefreshPipelineLLM(opts: {
  facts: string[];
  body: string;
  secondNovelty?: { hasNewFacts: boolean; body: string | null };
}): LLMProvider {
  let noveltyCalls = 0;
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async (request) => {
      if (request.jsonSchema?.name === "NarrativeDetectOutput") {
        noveltyCalls += 1;
        const decision = noveltyCalls === 2 && opts.secondNovelty
          ? opts.secondNovelty
          : { hasNewFacts: true, body: opts.body };
        return {
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
          tokensUsed: { prompt: 12, completion: 6, total: 18 },
          content: JSON.stringify({
            contradicted_claims: decision.hasNewFacts ? ["Phase 3 retrieval is planned."] : [],
            net_new_facts: decision.hasNewFacts ? opts.facts : [],
          }),
        };
      }
      if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
        return {
          model: "llama3.2",
          finishReason: "stop",
          rawProviderName: "ollama",
          tokensUsed: { prompt: 12, completion: 6, total: 18 },
          content: JSON.stringify({ body: opts.body }),
        };
      }
      return {
        model: "llama3.2",
        finishReason: "stop",
        rawProviderName: "ollama",
        tokensUsed: { prompt: 12, completion: 6, total: 18 },
        content: [
          "```json",
          JSON.stringify(decision),
          "```",
        ].join("\n"),
      };
    }),
  };
}
