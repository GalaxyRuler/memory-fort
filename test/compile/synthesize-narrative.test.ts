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
import type { LLMFinishReason, LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";
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

  it("writes relation-only frontmatter updates when novelty detection finds no body changes", async () => {
    await writeFileAt("wiki/tools/vitest.md", serializeFrontmatter({
      type: "tools",
      title: "Vitest",
      created: "2026-05-30",
      updated: "2026-05-30",
    }, "Vitest test runner.\n"));
    const llm = fakeNarrativeLLM({
      detect: { contradicted_claims: [], net_new_facts: [] },
      body: "unused",
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: relationFacts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result.outcome).toBe("rewritten");
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const parsed = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(parsed.frontmatter.updated).toBe("2026-06-01");
    expect(parsed.frontmatter.relations).toMatchObject({
      uses: ["wiki/tools/vitest.md"],
      "tested-with": ["wiki/tools/vitest.md"],
    });
    expect(existsSync(join(tmp, "wiki", ".history"))).toBe(false);
  });

  it("propagates matched relation triples from compressed source facts into frontmatter", async () => {
    await writeFileAt("wiki/tools/vitest.md", serializeFrontmatter({
      type: "tools",
      title: "Vitest",
      created: "2026-05-30",
      updated: "2026-05-30",
    }, "Vitest test runner.\n"));
    const llm = fakeNarrativeLLM({
      detect: {
        contradicted_claims: [],
        net_new_facts: ["Memory System graph coverage is tested with Vitest."],
      },
      body: "Memory System graph coverage is tested with Vitest while [[docs/ROADMAP]] tracks rollout decisions.",
    });

    await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: relationFacts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    const parsed = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(parsed.frontmatter.relations).toMatchObject({
      uses: ["wiki/tools/vitest.md"],
      "tested-with": ["wiki/tools/vitest.md"],
    });
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

  it("stages the page for review when prose makes unsupported claims", async () => {
    await writeFileAt("wiki/projects/famtree.md", serializeFrontmatter({
      type: "projects",
      title: "FamTree",
      created: "2026-06-22",
      updated: "2026-06-22",
      status: "active",
      lifecycle: "consolidated",
      version: 1,
    }, "FamTree directory exists.\n"));
    const llm = fakeNarrativeLLM({
      detect: { contradicted_claims: [], net_new_facts: ["FamTree directory exists."] },
      body: "FamTree is built with Supabase and the e2e suite passes.",
      faithfulness: { unsupported_claims: ["built with Supabase", "e2e suite passes"] },
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/famtree.md",
      facts: facts(),
      llm,
      now: new Date("2026-06-22T10:00:00.000Z"),
      faithfulnessCheck: true,
    });

    expect(result.proposed).toBe(true);
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it("rejects truncated novelty detection output", async () => {
    await expect(synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: [], net_new_facts: [] },
        body: "unused",
        detectFinishReason: "length",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    })).rejects.toThrow(/truncated.*length/);
  });

  it("rejects filtered synthesis output", async () => {
    await expect(synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: {
          contradicted_claims: [],
          net_new_facts: ["Memory System shipped a truncation guard."],
        },
        body: "Memory System shipped a truncation guard while [[docs/ROADMAP]] tracks rollout decisions.",
        synthFinishReason: "filter",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    })).rejects.toThrow(/truncated.*filter/);
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
      fact: compressedFact("Memory System retrieval", [
        "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      ]),
      text: "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      needs_review: false,
    },
    {
      fact_id: "f_1",
      fact: compressedFact("Memory System dashboard", [
        "Memory System dashboard added manual compile execution.",
      ]),
      text: "Memory System dashboard added manual compile execution.",
      needs_review: false,
    },
  ];
}

function relationFacts(): ConsolidationFact[] {
  return [
    {
      fact_id: "f_0",
      fact: {
        ...compressedFact("Memory System graph coverage", [
          "Memory System graph coverage is tested with Vitest.",
        ]),
        entities: ["Memory System", "Vitest"],
        relations: [
          { subject: "Memory System", predicate: "uses", object: "Vitest" },
          { subject: "Memory System", predicate: "tested-with", object: "Vitest" },
        ],
      },
      text: "Memory System graph coverage is tested with Vitest.",
      needs_review: false,
    },
  ];
}

function compressedFact(title: string, factLines: string[]) {
  return {
    title,
    facts: factLines,
    narrative: factLines.join(" "),
    concepts: ["Memory System"],
    files: [],
    importance: 8,
    type: "project" as const,
    sessionId: "session-a",
    sourceRawPath: "raw/2026-05-31/session-a.md",
    observedAt: "2026-05-31T00:00:00.000Z",
    compressedAt: "2026-05-31T12:00:00.000Z",
  };
}

function fakeNarrativeLLM(opts: {
  detect: { contradicted_claims: string[]; net_new_facts: string[] };
  body: string;
  faithfulness?: { unsupported_claims: string[] };
  detectFinishReason?: LLMFinishReason;
  synthFinishReason?: LLMFinishReason;
}): LLMProvider {
  const chat = vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
    if (request.jsonSchema?.name === "NarrativeDetectOutput") {
      return fakeResponse(JSON.stringify(opts.detect), opts.detectFinishReason);
    }
    if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
      return fakeResponse(JSON.stringify({ body: opts.body }), opts.synthFinishReason);
    }
    if (request.jsonSchema?.name === "FaithfulnessOutput" && opts.faithfulness) {
      return fakeResponse(JSON.stringify(opts.faithfulness));
    }
    throw new Error(`unexpected schema ${request.jsonSchema?.name ?? "none"}`);
  });
  return { providerName: "test", modelName: "test", chat };
}

function fakeResponse(content: string, finishReason: LLMFinishReason = "stop"): LLMResponse {
  return {
    model: "test",
    finishReason,
    rawProviderName: "test",
    tokensUsed: { prompt: 30, completion: 12, total: 42 },
    content,
  };
}
