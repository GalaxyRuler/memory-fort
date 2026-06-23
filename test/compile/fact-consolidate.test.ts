import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFactConsolidation } from "../../src/compile/fact-consolidate.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";

describe("fact-first compile consolidation", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fact-consolidate-"));
    await writePage("wiki/projects/memory-system.md", "Memory System", "Memory System captures raw observations.");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("consolidates an entity from top-eight important facts under the LLM call cap without raw transcript noise", async () => {
    for (let index = 1; index <= 11; index += 1) {
      await writeFact(`facts/2026-05-31/session-${index}.json`, {
        title: `Memory System fact ${index}`,
        facts: [`Memory System important fact ${index}.`],
        narrative: `Memory System narrative ${index}.`,
        concepts: ["Memory System"],
        files: [],
        importance: index,
        sessionId: `session-${index}`,
        sourceRawPath: `raw/2026-05-31/session-${index}.md`,
        observedAt: `2026-05-31T10:${String(index).padStart(2, "0")}:00.000Z`,
        compressedAt: "2026-05-31T12:00:00.000Z",
      });
    }
    await writeFact("facts/2026-05-31/noise.json", {
      title: "Low value mention",
      facts: ["SEARCH RESULT CARD COPY SHOULD NOT ENTER THE MEMORY SYSTEM PAGE."],
      narrative: "Unrelated UX prompt.",
      concepts: ["Memory System"],
      files: [],
      importance: 3,
      sessionId: "noise",
      sourceRawPath: "raw/2026-05-31/noise.md",
      observedAt: "2026-05-31T11:00:00.000Z",
      compressedAt: "2026-05-31T12:00:00.000Z",
    });
    const llm = fakeSectionPatchLLM([
      "Memory System captures raw observations.",
      "Memory System important fact 11.",
      "Memory System important fact 10.",
      "Memory System important fact 9.",
      "Memory System important fact 8.",
      "Memory System important fact 7.",
      "Memory System important fact 6.",
      "Memory System important fact 5.",
      "Memory System important fact 4.",
    ].join("\n"));

    const result = await runFactConsolidation({
      vaultRoot: tmp,
      llm,
      maxCalls: 1,
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.summary).toMatchObject({ conceptsEligible: 1, llmCalls: 2, pagesUpdated: 1, factsConsidered: 8 });
    expect(llm.chat).toHaveBeenCalledTimes(2);
    const prompt = vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content;
    expect(prompt).toContain("Memory System important fact 11.");
    expect(prompt).toContain("Memory System important fact 4.");
    expect(prompt).not.toContain("Memory System important fact 3.");
    expect(prompt).not.toContain("SEARCH RESULT CARD COPY");
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.body).toContain("important fact 10");
    expect(written.body).not.toContain("SEARCH RESULT CARD COPY");
    expect(written.frontmatter.version).toBe(2);
    expect(written.frontmatter.supersedes).toEqual([
      expect.objectContaining({ path: "wiki/.history/wiki/projects/memory-system.md/2026-05-31T12-00-00-000Z.md" }),
    ]);
  });

  it("is idempotent when synthesis returns the existing body", async () => {
    await writeFact("facts/2026-05-31/a.json", fact("a", 8));
    await writeFact("facts/2026-05-31/b.json", fact("b", 7));
    await writeFact("facts/2026-05-31/c.json", fact("c", 6));
    const before = await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8");
    const llm = fakeSectionPatchLLM("Memory System captures raw observations.");

    const result = await runFactConsolidation({
      vaultRoot: tmp,
      llm,
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.summary.pagesUnchanged).toBe(1);
    await expect(readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8")).resolves.toBe(before);
    expect(existsSync(join(tmp, "wiki", ".history"))).toBe(false);
  });

  it("routes typed procedure facts to a procedure page when a same-title project page exists", async () => {
    await writePage("wiki/projects/systematic-debugging.md", "Systematic Debugging", "Systematic Debugging project notes.");
    await writePage("wiki/procedures/systematic-debugging.md", "Systematic Debugging", "Systematic Debugging procedure notes.", "procedures");
    for (let index = 1; index <= 3; index += 1) {
      await writeFact(`facts/2026-05-31/procedure-${index}.json`, {
        ...fact(`procedure-${index}`, 8),
        title: `Systematic Debugging procedure ${index}`,
        facts: [`Systematic Debugging procedure step ${index}.`],
        narrative: `Systematic Debugging procedure step ${index}.`,
        concepts: ["Systematic Debugging"],
        type: "procedure",
      });
    }
    const llm = fakeSectionPatchLLM("Systematic Debugging procedure notes. Systematic Debugging procedure step 3.");

    const result = await runFactConsolidation({
      vaultRoot: tmp,
      llm,
      maxCalls: 1,
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(result.applied).toEqual(["wiki/procedures/systematic-debugging.md"]);
    const procedurePage = await readFile(join(tmp, "wiki", "procedures", "systematic-debugging.md"), "utf-8");
    const projectPage = await readFile(join(tmp, "wiki", "projects", "systematic-debugging.md"), "utf-8");
    expect(procedurePage).toContain("procedure step 3");
    expect(projectPage).toContain("Systematic Debugging project notes.");
    expect(projectPage).not.toContain("procedure step 3");
  });

  it("counts faithfulness LLM calls when unsupported prose is staged for review", async () => {
    await writeFact("facts/2026-05-31/a.json", fact("a", 8));
    await writeFact("facts/2026-05-31/b.json", fact("b", 7));
    await writeFact("facts/2026-05-31/c.json", fact("c", 6));
    const llm = fakeSectionPatchLLM("Memory System is backed by Supabase and all e2e tests pass.", {
      faithfulness: { unsupported_claims: ["backed by Supabase", "all e2e tests pass"] },
    });

    const result = await runFactConsolidation({
      vaultRoot: tmp,
      llm,
      maxCalls: 1,
      now: new Date("2026-05-31T12:00:00.000Z"),
      faithfulnessCheck: true,
    });

    expect(llm.chat).toHaveBeenCalledTimes(3);
    expect(result.summary.llmCalls).toBe(3);
    expect(result.proposed).toEqual(["wiki/compile-proposed/memory-system.md"]);
  });

  async function writePage(relPath: string, title: string, body: string, type = "projects"): Promise<void> {
    await writeFileAt(relPath, serializeFrontmatter({
      type,
      title,
      created: "2026-05-31",
      updated: "2026-05-31",
      status: "active",
      lifecycle: "consolidated",
      source: "compile-execute",
      cognitive_type: "semantic",
      version: 1,
    }, `${body}\n`));
  }

  async function writeFact(relPath: string, fact: Record<string, unknown>): Promise<void> {
    await writeFileAt(relPath, `${JSON.stringify({ facts: [fact] }, null, 2)}\n`);
  }

  async function writeFileAt(relPath: string, content: string): Promise<void> {
    const fullPath = join(tmp, ...relPath.split("/"));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }
});

function fact(sessionId: string, importance: number) {
  return {
    title: `Memory System ${sessionId}`,
    facts: [`Memory System fact ${sessionId}.`],
    narrative: `Memory System narrative ${sessionId}.`,
    concepts: ["Memory System"],
    files: [],
    importance,
    sessionId,
    sourceRawPath: `raw/2026-05-31/${sessionId}.md`,
    observedAt: "2026-05-31T12:00:00.000Z",
    compressedAt: "2026-05-31T12:00:00.000Z",
  };
}

function fakeSectionPatchLLM(body: string, opts: { faithfulness?: { unsupported_claims: string[] } } = {}): LLMProvider {
  const chat = vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
    if (request.jsonSchema?.name === "NarrativeDetectOutput") {
      const factIds = [...(request.messages.at(-1)?.content ?? "").matchAll(/"fact_id":\s*"([^"]+)"/g)]
        .map((match) => match[1]!)
        .slice(0, body === "Memory System captures raw observations." ? 0 : 8);
      return fakeResponse(JSON.stringify({
        contradicted_claims: [],
        net_new_facts: factIds,
      }));
    }
    if (request.jsonSchema?.name === "NarrativeSynthesisOutput") {
      return fakeResponse(JSON.stringify({
        body,
      }));
    }
    if (request.jsonSchema?.name === "FaithfulnessOutput" && opts.faithfulness) {
      return fakeResponse(JSON.stringify(opts.faithfulness));
    }
    throw new Error(`unexpected schema ${request.jsonSchema?.name ?? "none"}`);
  });
  return {
    providerName: "openrouter",
    modelName: "test",
    chat,
  };
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
