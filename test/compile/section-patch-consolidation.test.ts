import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { parsePageIR } from "../../src/compile/parse-pageir.js";
import { compileSectionPatch } from "../../src/compile/patch-compiler.js";
import { applyOperation } from "../../src/compile/execute.js";
import { runFactConsolidation } from "../../src/compile/fact-consolidate.js";
import { renderSectionPatch } from "../../src/compile/renderer.js";
import { validateRender } from "../../src/compile/validate-patch.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { createOpenRouterLLM } from "../../src/llm/openrouter.js";
import { createOllamaLLM } from "../../src/llm/ollama.js";
import { LLMConfigError } from "../../src/llm/types.js";

describe("section-patch consolidation", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "section-patch-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("parses PageIR sections, hashes section bodies, and extracts claims only from paragraphs", () => {
    const page = [
      "---",
      "type: projects",
      "title: Memory System",
      "version: 3",
      "---",
      "",
      "# Memory System",
      "",
      "## Phase 3",
      "",
      "Phase 3 is planned. It will add retrieval later.",
      "",
      "```ts",
      "const misleading = 'Code fences are not claims. Even with periods.';",
      "```",
      "",
      "- Lists are structured blocks and not claims.",
      "",
      "### Dashboard",
      "",
      "The dashboard is shipped with compile controls.",
      "",
    ].join("\n");

    const ir = parsePageIR(page);

    expect(ir.title).toBe("Memory System");
    expect(ir.page_version).toBe(3);
    expect(ir.sections).toHaveLength(2);
    expect(ir.sections[0]).toMatchObject({
      heading: "Phase 3",
      level: 2,
      position_index: 0,
      has_structured_blocks: true,
    });
    expect(ir.sections[0]?.body_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(ir.sections[0]?.claims.map((claim) => claim.text)).toEqual([
      "Phase 3 is planned.",
      "It will add retrieval later.",
    ]);
    expect(ir.sections[1]).toMatchObject({
      heading: "Dashboard",
      level: 3,
      position_index: 1,
      has_structured_blocks: false,
    });
    expect(ir.sections[1]?.claims.map((claim) => claim.text)).toEqual([
      "The dashboard is shipped with compile controls.",
    ]);
  });

  it("applies a hash-guarded section_patch and verifies final Markdown bytes", async () => {
    const path = "wiki/projects/memory-system.md";
    const fullPath = join(root, ...path.split("/"));
    const current = [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-05-30",
      "updated: 2026-05-30",
      "version: 1",
      "---",
      "",
      "# Memory System",
      "",
      "## Phase 3",
      "",
      "Phase 3 is planned. It will add retrieval later.",
      "",
      "## Dashboard",
      "",
      "The dashboard exposes compile state.",
      "",
    ].join("\n");
    await writeFile(fullPath, current);
    const ir = parsePageIR(current);
    const phaseSection = ir.sections.find((section) => section.heading === "Phase 3");
    expect(phaseSection).toBeDefined();

    const operation = compileSectionPatch({
      path,
      page: ir,
      sectionId: phaseSection!.section_id,
      bodyHash: phaseSection!.body_hash,
      replacementParagraphs: [
        "Phase 3 retrieval is shipped. The live retrieval stack combines BM25 lexical search with Voyage embeddings, reciprocal-rank fusion, and reranking before consolidation.",
      ],
    });
    const applied = await applyOperation(root, operation, new Date("2026-06-01T00:00:00Z"));

    expect(applied).toEqual({ ok: true, outcome: "rewritten" });
    const finalBytes = await readFile(fullPath, "utf-8");
    expect(finalBytes).toContain("version: 2");
    expect(finalBytes).toContain("supersedes:");
    expect(finalBytes).toContain("Phase 3 retrieval is shipped");
    expect(finalBytes).toContain("BM25");
    expect(finalBytes).toContain("Voyage");
    expect(finalBytes).toContain("reciprocal-rank fusion");
    expect(finalBytes).toContain("reranking");
    expect(finalBytes).not.toContain("Phase 3 is planned");
    expect(finalBytes).not.toContain("Additional Information");
    const historyFile = join(root, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T00-00-00-000Z.md");
    await expect(readFile(historyFile, "utf-8")).resolves.toContain("Phase 3 is planned");
  });

  it("rejects section_patch when the section body hash changed before apply", async () => {
    const path = "wiki/projects/memory-system.md";
    const fullPath = join(root, ...path.split("/"));
    const current = [
      "---",
      "type: projects",
      "title: Memory System",
      "created: 2026-05-30",
      "updated: 2026-05-30",
      "version: 1",
      "---",
      "",
      "## Phase 3",
      "",
      "Phase 3 is planned.",
      "",
    ].join("\n");
    await writeFile(fullPath, current);
    const ir = parsePageIR(current);
    const section = ir.sections[0]!;
    await writeFile(fullPath, current.replace("Phase 3 is planned.", "Phase 3 is already shipped."));

    const applied = await applyOperation(root, compileSectionPatch({
      path,
      page: ir,
      sectionId: section.section_id,
      bodyHash: section.body_hash,
      replacementParagraphs: [
        "Phase 3 retrieval is shipped with BM25, Voyage embeddings, reciprocal-rank fusion, and reranking.",
      ],
    }), new Date("2026-06-01T00:00:00Z"));

    expect(applied).toEqual({ ok: false, reason: "section_patch body_hash mismatch" });
    await expect(readFile(fullPath, "utf-8")).resolves.toContain("Phase 3 is already shipped.");
  });
});

describe("LLM structured output support", () => {
  it("passes json_schema response_format to OpenRouter", async () => {
    const createMock = vi.fn(async () => ({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      model: "test-model",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    const provider = createOpenRouterLLM({
      apiKey: "test",
      model: "test-model",
      client: { chat: { completions: { create: createMock } } },
    });
    await provider.chat({
      messages: [{ role: "user", content: "x" }],
      jsonSchema: {
        name: "TestSchema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok"],
          properties: { ok: { type: "boolean" } },
        },
      },
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "TestSchema",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["ok"],
              properties: { ok: { type: "boolean" } },
            },
          },
        },
      }),
      expect.any(Object),
    );
  });

  it("rejects structured-output requests for Ollama", async () => {
    const provider = createOllamaLLM();

    await expect(provider.chat({
      messages: [{ role: "user", content: "x" }],
      jsonSchema: {
        name: "Nope",
        schema: { type: "object" },
      },
    })).rejects.toThrow(LLMConfigError);
  });
});

describe("fact consolidation section-patch pipeline", () => {
  let tmp: string;
  let root: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "fact-section-patch-"));
    root = join(tmp, ".memory");
    await mkdir(join(root, "wiki", "projects"), { recursive: true });
    await mkdir(join(root, "facts", "2026-05-30"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("updates final Markdown bytes through section patches and drops workflow noise", async () => {
    await writeFile(
      join(root, "wiki", "projects", "memory-system.md"),
      [
        "---",
        "type: projects",
        "title: memory system",
        "created: 2026-05-30",
        "updated: 2026-05-30",
        "version: 1",
        "---",
        "",
        "# memory system",
        "",
        "## Phase 3",
        "",
        "Phase 3 is planned. It will add retrieval later.",
        "",
        "## Dashboard",
        "",
        "The dashboard exposes compile state.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "facts", "2026-05-30", "session.json"),
      JSON.stringify({
        version: 1,
        sourceRawPath: "raw/2026-05-30/session.md",
        sessionId: "session",
        observedAt: "2026-05-30T00:00:00.000Z",
        compressedAt: "2026-05-30T01:00:00.000Z",
        facts: [
          {
            title: "Phase 3 shipped",
            facts: ["Phase 3 retrieval is shipped with BM25, Voyage embeddings, RRF fusion, and reranking."],
            narrative: "Phase 3 retrieval is shipped with BM25, Voyage embeddings, RRF fusion, and reranking.",
            concepts: ["memory system"],
            files: [],
            importance: 8,
            sessionId: "session",
            sourceRawPath: "raw/2026-05-30/session.md",
            observedAt: "2026-05-30T00:00:00.000Z",
            compressedAt: "2026-05-30T01:00:00.000Z",
          },
          {
            title: "Workflow noise",
            facts: ["Target: Codex 5.5. Subagent A focuses on planner implementation."],
            narrative: "Target: Codex 5.5. Subagent A focuses on planner implementation.",
            concepts: ["memory system"],
            files: [],
            importance: 9,
            sessionId: "session",
            sourceRawPath: "raw/2026-05-30/session.md",
            observedAt: "2026-05-30T00:00:00.000Z",
            compressedAt: "2026-05-30T01:00:00.000Z",
          },
        ],
      }, null, 2),
    );
    const llm = fakePlannerRendererLLM();

    await runFactConsolidation({
      vaultRoot: root,
      llm,
      minFacts: 1,
      maxCalls: 1,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    const finalBytes = await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8");
    expect(finalBytes).toContain("Phase 3 retrieval is shipped");
    expect(finalBytes).toContain("BM25");
    expect(finalBytes).toContain("Voyage");
    expect(finalBytes).toContain("RRF");
    expect(finalBytes).toContain("reranking");
    expect(finalBytes).not.toContain("Phase 3 is planned");
    expect(finalBytes).not.toContain("Additional Information");
    expect(finalBytes).not.toContain("Target: Codex");
    expect(finalBytes).not.toContain("Subagent");
    expect(finalBytes.match(/dashboard/gi)).toHaveLength(2);
    expect(finalBytes).toContain("version: 2");
    await expect(readFile(join(root, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T00-00-00-000Z.md"), "utf-8"))
      .resolves.toContain("Phase 3 is planned");
  });

  it("updates checklist sections through replacement_blocks without removing or reordering existing items", async () => {
    await writeFile(
      join(root, "wiki", "projects", "memory-system.md"),
      [
        "---",
        "type: projects",
        "title: memory system",
        "created: 2026-05-30",
        "updated: 2026-05-30",
        "version: 1",
        "---",
        "",
        "# memory system",
        "",
        "## Plan",
        "",
        "- [x] Phase 1 shipped",
        "- [ ] Phase 4.29 planned",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "facts", "2026-05-30", "session.json"),
      JSON.stringify({
        version: 1,
        sourceRawPath: "raw/2026-05-30/session.md",
        sessionId: "session",
        observedAt: "2026-05-30T00:00:00.000Z",
        compressedAt: "2026-05-30T01:00:00.000Z",
        facts: [
          {
            title: "Phase 4.29 shipped",
            facts: ["Phase 4.29 shipped with section-patch consolidation."],
            narrative: "Phase 4.29 shipped with section-patch consolidation.",
            concepts: ["memory system"],
            files: [],
            importance: 8,
            sessionId: "session",
            sourceRawPath: "raw/2026-05-30/session.md",
            observedAt: "2026-05-30T00:00:00.000Z",
            compressedAt: "2026-05-30T01:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    await runFactConsolidation({
      vaultRoot: root,
      llm: fakeChecklistPlannerRendererLLM(),
      minFacts: 1,
      maxCalls: 1,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    const finalBytes = await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8");
    expect(finalBytes).toContain("- [x] Phase 1 shipped");
    expect(finalBytes).toContain("- [x] Phase 4.29 shipped");
    expect(finalBytes.indexOf("- [x] Phase 1 shipped")).toBeLessThan(finalBytes.indexOf("- [x] Phase 4.29 shipped"));
    expect(finalBytes).not.toContain("Additional Information");
    expect(finalBytes).toContain("version: 2");
    await expect(readFile(join(root, "wiki", ".history", "wiki", "projects", "memory-system.md", "2026-06-01T00-00-00-000Z.md"), "utf-8"))
      .resolves.toContain("- [ ] Phase 4.29 planned");
  });

  it("passes Additional Information as a baseline forbidden term to every renderer call", async () => {
    const page = parsePageIR([
      "---",
      "type: projects",
      "title: Memory System",
      "---",
      "",
      "## Status",
      "",
      "Phase 4.29 is currently planned.",
      "",
    ].join("\n"));
    const section = page.sections[0]!;
    const llm: LLMProvider = {
      providerName: "fake",
      modelName: "fake",
      async chat(request) {
        expect(request.messages.at(-1)?.content).toContain("Additional Information");
        return fakeResponse(JSON.stringify({
          section_id: section.section_id,
          replacement_paragraphs: [
            "Phase 4.29 section-patch consolidation is shipped and validated. The previous planned-state wording is obsolete for this fixture.",
          ],
          coverage: [{ fact_id: "f_0", paragraph_index: 0 }],
        }));
      },
    };

    await renderSectionPatch({
      llm,
      section,
      job: {
        section_id: section.section_id,
        operation: "replace_section_body",
        accepted_fact_ids: ["f_0"],
        remove_claim_ids: [],
        required_terms: [],
        forbidden_terms: [],
        section_claims: [],
      },
      facts: [{
        fact_id: "f_0",
        text: "Phase 4.29 section-patch consolidation is shipped and validated.",
        needs_review: false,
        fact: {
          title: "Phase 4.29 shipped",
          facts: ["Phase 4.29 section-patch consolidation is shipped and validated."],
          narrative: "Phase 4.29 section-patch consolidation is shipped and validated.",
          concepts: ["Memory System"],
          files: [],
          importance: 8,
          sessionId: "session",
          sourceRawPath: "raw/2026-05-30/session.md",
          observedAt: "2026-05-30T00:00:00.000Z",
          compressedAt: "2026-05-30T01:00:00.000Z",
        },
      }],
    });
  });

  it("stages renderer output that contains Additional Information without changing the canonical page", async () => {
    await writeFile(
      join(root, "wiki", "projects", "memory-system.md"),
      [
        "---",
        "type: projects",
        "title: memory system",
        "created: 2026-05-30",
        "updated: 2026-05-30",
        "version: 1",
        "---",
        "",
        "# memory system",
        "",
        "## Phase 4.29",
        "",
        "Phase 4.29 is currently planned.",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "facts", "2026-05-30", "session.json"),
      JSON.stringify({
        version: 1,
        sourceRawPath: "raw/2026-05-30/session.md",
        sessionId: "session",
        observedAt: "2026-05-30T00:00:00.000Z",
        compressedAt: "2026-05-30T01:00:00.000Z",
        facts: [
          {
            title: "Phase 4.29 shipped",
            facts: ["Phase 4.29 section-patch consolidation shipped and validated."],
            narrative: "Phase 4.29 section-patch consolidation shipped and validated.",
            concepts: ["memory system"],
            files: [],
            importance: 8,
            sessionId: "session",
            sourceRawPath: "raw/2026-05-30/session.md",
            observedAt: "2026-05-30T00:00:00.000Z",
            compressedAt: "2026-05-30T01:00:00.000Z",
          },
        ],
      }, null, 2),
    );

    const result = await runFactConsolidation({
      vaultRoot: root,
      llm: fakeInvalidAdditionalInfoRendererLLM(),
      minFacts: 1,
      maxCalls: 1,
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.proposed).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({
      outcome: "staged-for-review",
      reason: "section render invalid: render emitted Additional Information",
      contentPreserved: true,
    });
    const finalBytes = await readFile(join(root, "wiki", "projects", "memory-system.md"), "utf-8");
    expect(finalBytes).toContain("Phase 4.29 is currently planned.");
    expect(finalBytes).toContain("version: 1");
    expect(finalBytes).not.toContain("version: 2");
    await expect(readFile(join(root, ...result.proposed[0]!.split("/")), "utf-8"))
      .resolves.toContain("Additional Information");
  });

  it("rejects checklist replacement_blocks that reorder existing items", () => {
    const page = parsePageIR([
      "---",
      "type: projects",
      "title: Memory System",
      "---",
      "",
      "## Plan",
      "",
      "- [x] Phase 1 shipped",
      "- [ ] Phase 4.29 planned",
      "",
    ].join("\n"));
    const section = page.sections[0]!;

    expect(() => validateRender({
      section_id: section.section_id,
      replacement_blocks: [
        {
          type: "checklist",
          items: [
            { checked: true, text: "Phase 4.29 shipped" },
            { checked: true, text: "Phase 1 shipped" },
          ],
        },
      ],
      coverage: [{ fact_id: "f_0", block_index: 0 }],
    }, {
      section_id: section.section_id,
      operation: "replace_section_body",
      accepted_fact_ids: ["f_0"],
      remove_claim_ids: [],
      required_terms: [],
      forbidden_terms: [],
      section_claims: [],
    }, section)).toThrow("checklist reordered existing items");
  });
});

function fakePlannerRendererLLM(): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake",
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const schemaName = request.jsonSchema?.name;
      if (schemaName === "PlannerOutput") {
        const sectionId = /section_id=([a-z0-9_]+)/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "";
        const claimId = /claim_id=([a-z0-9_]+)/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_jobs: [
            {
              section_id: sectionId,
              operation: "replace_section_body",
              accepted_fact_ids: [factId],
              remove_claim_ids: [claimId],
              required_terms: ["BM25", "Voyage", "RRF", "reranking"],
              forbidden_terms: ["Phase 3 is planned", "Target: Codex", "Subagent", "Additional Information"],
              section_claims: [
                {
                  claim: "Phase 3 retrieval is shipped with BM25, Voyage embeddings, RRF fusion, and reranking.",
                  source_fact_ids: [factId],
                },
              ],
              claim_reason: "status_change",
            },
          ],
          dropped_facts: [{ fact_id: factId === "f_0" ? "f_1" : "f_0", reason: "workflow_noise" }],
          unresolved_conflicts: [],
        }));
      }
      if (schemaName === "RendererOutput") {
        const sectionId = /section_id=([a-z0-9_]+)/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(request.messages.at(-1)?.content ?? "")?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_id: sectionId,
          replacement_paragraphs: [
            "Phase 3 retrieval is shipped with BM25 lexical search, Voyage embeddings, RRF fusion, and reranking before consolidation. The previous plan-only wording is obsolete, and follow-up work should focus on evaluation and reliability.",
          ],
          coverage: [{ fact_id: factId, paragraph_index: 0 }],
        }));
      }
      throw new Error(`unexpected schema ${schemaName ?? "none"}`);
    },
  };
}

function fakeChecklistPlannerRendererLLM(): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake",
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const schemaName = request.jsonSchema?.name;
      const content = request.messages.at(-1)?.content ?? "";
      if (schemaName === "PlannerOutput") {
        const planSection = [...content.matchAll(/section_id=([a-z0-9_]+)[\s\S]*?heading=([^\n]+)/g)]
          .find((match) => match[2] === "Plan");
        const sectionId = planSection?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_jobs: [
            {
              section_id: sectionId,
              operation: "replace_section_body",
              accepted_fact_ids: [factId],
              remove_claim_ids: [],
              required_terms: ["Phase 4.29"],
              forbidden_terms: [],
              section_claims: [
                {
                  claim: "Phase 4.29 shipped with section-patch consolidation.",
                  source_fact_ids: [factId],
                },
              ],
            },
          ],
          dropped_facts: [],
          unresolved_conflicts: [],
        }));
      }
      if (schemaName === "RendererOutput") {
        const sectionId = /section_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_id: sectionId,
          replacement_blocks: [
            {
              type: "checklist",
              items: [
                { checked: true, text: "Phase 1 shipped" },
                { checked: true, text: "Phase 4.29 shipped" },
              ],
            },
          ],
          coverage: [{ fact_id: factId, block_index: 0 }],
        }));
      }
      throw new Error(`unexpected schema ${schemaName ?? "none"}`);
    },
  };
}

function fakeInvalidAdditionalInfoRendererLLM(): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake",
    async chat(request: LLMRequest): Promise<LLMResponse> {
      const schemaName = request.jsonSchema?.name;
      const content = request.messages.at(-1)?.content ?? "";
      if (schemaName === "PlannerOutput") {
        const sectionId = /section_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        const claimId = /claim_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_jobs: [
            {
              section_id: sectionId,
              operation: "replace_section_body",
              accepted_fact_ids: [factId],
              remove_claim_ids: [claimId],
              required_terms: ["Phase 4.29"],
              forbidden_terms: [],
              section_claims: [
                {
                  claim: "Phase 4.29 section-patch consolidation shipped and validated.",
                  source_fact_ids: [factId],
                },
              ],
              claim_reason: "status_change",
            },
          ],
          dropped_facts: [],
          unresolved_conflicts: [],
        }));
      }
      if (schemaName === "RendererOutput") {
        const sectionId = /section_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        const factId = /fact_id=([a-z0-9_]+)/.exec(content)?.[1] ?? "";
        return fakeResponse(JSON.stringify({
          section_id: sectionId,
          replacement_paragraphs: [
            "Additional Information: Phase 4.29 section-patch consolidation shipped and validated.",
          ],
          coverage: [{ fact_id: factId, paragraph_index: 0 }],
        }));
      }
      throw new Error(`unexpected schema ${schemaName ?? "none"}`);
    },
  };
}

function fakeResponse(content: string): LLMResponse {
  return {
    content,
    model: "fake",
    finishReason: "stop",
    rawProviderName: "fake",
    tokensUsed: { prompt: 1, completion: 1, total: 2 },
  };
}
