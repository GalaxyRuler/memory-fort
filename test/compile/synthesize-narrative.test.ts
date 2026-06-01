import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  synthesizeNarrative,
  validateNarrativeBody,
  type SynthesisResult,
} from "../../src/compile/synthesize-narrative.js";
import type { ConsolidationFact } from "../../src/compile/filter-noise.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";

describe("synthesizeNarrative", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "synthesize-narrative-"));
    await writePage("wiki/projects/memory-system.md", [
      "Memory System captures raw observations.",
      "",
      "## 2026-05-30 update",
      "",
      "- Phase 3 retrieval is planned.",
      "- [[docs/ROADMAP]] tracks the rollout.",
      "",
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("rewrites a knowledge page as one narrative body and archives the prior bytes", async () => {
    const llm = fakeNarrativeLLM({
      detect: {
        contradicted_claims: ["Phase 3 retrieval is planned."],
        net_new_facts: ["Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion."],
      },
      body: [
        "Memory System captures raw observations and compiles them into durable knowledge records.",
        "Phase 3 retrieval shipped with BM25, vector, graph, and metadata fusion, and [[docs/ROADMAP]] still tracks rollout decisions.",
      ].join("\n"),
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject<SynthesisResult>({
      outcome: "rewritten",
      path: "wiki/projects/memory-system.md",
      proposed: false,
    });
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(vi.mocked(llm.chat).mock.calls[0]![0].jsonSchema?.name).toBe("NarrativeDetectOutput");
    expect(vi.mocked(llm.chat).mock.calls[1]![0].jsonSchema?.name).toBe("NarrativeSynthesisOutput");

    const written = await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8");
    const parsed = parseFrontmatter(written);
    expect(parsed.body).not.toMatch(/^##\s/m);
    expect(parsed.body).not.toMatch(/^\s*[-*+]\s/m);
    expect(parsed.body).not.toContain("```");
    expect(parsed.frontmatter.version).toBe(2);
    expect(parsed.frontmatter.updated).toBe("2026-06-01");
    expect(parsed.frontmatter.last_accessed).toBe("2026-06-01");
    expect(parsed.frontmatter.strength).toBe(8);
    expect(parsed.frontmatter.source_facts).toEqual(["f_0", "f_1"]);
    expect(parsed.frontmatter.supersedes).toEqual([
      expect.objectContaining({
        path: "wiki/.history/wiki/projects/memory-system.md/2026-06-01T10-00-00-000Z.md",
        version: 1,
      }),
    ]);
    expect(parsed.body).toContain("Phase 3 retrieval shipped");
    expect(parsed.body).toContain("[[docs/ROADMAP]]");

    const history = join(tmp, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T10-00-00-000Z.md");
    expect(existsSync(history)).toBe(true);
    expect(await readFile(history, "utf-8")).toContain("## 2026-05-30 update");
  });

  it("does not write or archive when novelty detection finds no changes", async () => {
    const before = await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8");
    const llm = fakeNarrativeLLM({
      detect: { contradicted_claims: [], net_new_facts: [] },
      body: "unused",
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result.outcome).toBe("unchanged");
    expect(llm.chat).toHaveBeenCalledTimes(1);
    await expect(readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8")).resolves.toBe(before);
    expect(existsSync(join(tmp, "wiki", ".history"))).toBe(false);
  });

  it("stages synthesized output that violates narrative shape", async () => {
    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: [], net_new_facts: ["New detail."] },
        body: ["Memory System detail.", "", "- structured bullet"].join("\n"),
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "staged-for-review",
      proposed: true,
      proposedPath: "wiki/compile-proposed/memory-system.md",
    });
    expect(await readdir(join(tmp, "wiki", "compile-proposed"))).toEqual(["memory-system.md"]);
  });

  it("validates canonical narrative body syntax", () => {
    expect(validateNarrativeBody("One paragraph.\n\nAnother paragraph.")).toEqual({ ok: true });
    expect(validateNarrativeBody("## Heading\n\nBody")).toMatchObject({ ok: false });
    expect(validateNarrativeBody("- item")).toMatchObject({ ok: false });
    expect(validateNarrativeBody("```ts\ncode\n```")).toMatchObject({ ok: false });
    expect(validateNarrativeBody("| A | B |\n| - | - |")).toMatchObject({ ok: false });
  });

  async function writePage(relPath: string, body: string): Promise<void> {
    await writeFileAt(relPath, serializeFrontmatter({
      type: "projects",
      title: "Memory System",
      created: "2026-05-30",
      updated: "2026-05-30",
      status: "active",
      lifecycle: "consolidated",
      version: 1,
    }, body));
  }

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function facts(): ConsolidationFact[] {
  return [
    {
      fact_id: "f_0",
      fact: "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      text: "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      needs_review: false,
    },
    {
      fact_id: "f_1",
      fact: "Memory System dashboard added manual compile execution.",
      text: "Memory System dashboard added manual compile execution.",
      needs_review: false,
    },
  ];
}

function fakeNarrativeLLM(opts: {
  detect: { contradicted_claims: string[]; net_new_facts: string[] };
  body: string;
}): LLMProvider {
  const chat = vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
    if (request.jsonSchema?.name === "NarrativeDetectOutput") {
      return fakeResponse(JSON.stringify(opts.detect));
    }
    if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
      return fakeResponse(JSON.stringify({ body: opts.body }));
    }
    throw new Error(`unexpected schema ${request.jsonSchema?.name ?? "none"}`);
  });
  return { providerName: "test", modelName: "test", chat };
}

function fakeResponse(content: string): LLMResponse {
  return {
    model: "test",
    finishReason: "stop",
    rawProviderName: "test",
    tokensUsed: { prompt: 30, completion: 12, total: 42 },
    content,
  };
}
