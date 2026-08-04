import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findUnfilledPlaceholder,
  sanitizeProposalReason,
  stageNarrativeReview,
  synthesizeNarrative,
  validateNarrativeBody,
  type SynthesisResult,
} from "../../src/compile/synthesize-narrative.js";
import type { ConsolidationFact } from "../../src/compile/filter-noise.js";
import type { LLMFinishReason, LLMProvider, LLMRequest, LLMResponse } from "../../src/llm/types.js";
import { parseFrontmatter, serializeFrontmatter } from "../../src/storage/frontmatter.js";

describe("findUnfilledPlaceholder", () => {
  it("flags unfilled template placeholders", () => {
    expect(findUnfilledPlaceholder("Focus on [specific areas of enhancement and testing] next.")).toBe("[specific areas of enhancement and testing]");
    expect(findUnfilledPlaceholder("Deadline: [TBD]")).toBe("[TBD]");
    expect(findUnfilledPlaceholder("Note [TODO: fill in the details]")).toBe("[TODO: fill in the details]");
  });

  it("ignores wikilinks, markdown links, checkboxes, citations, and redaction markers", () => {
    expect(findUnfilledPlaceholder("See [[memory fort planning notes]] for context.")).toBeNull();
    expect(findUnfilledPlaceholder("Read [the latest project docs](https://example.com).")).toBeNull();
    expect(findUnfilledPlaceholder("- [x] done and [ ] pending")).toBeNull();
    expect(findUnfilledPlaceholder("Citation [1] and [REDACTED: api-key] stay.")).toBeNull();
  });
});

describe("sanitizeProposalReason", () => {
  it("flattens whitespace, redacts secrets, and bounds length", () => {
    const reason = `unsupported\nclaims: OPENROUTER_API_KEY=sk-live-${"a".repeat(40)} ${"evidence ".repeat(100)}`;
    const sanitized = sanitizeProposalReason(reason);
    expect(sanitized.length).toBeLessThanOrEqual(300);
    expect(sanitized).not.toContain("sk-live-");
    expect(sanitized).not.toContain("\n");
    expect(sanitized.endsWith("...")).toBe(true);
  });

  it("leaves short reasons unchanged", () => {
    expect(sanitizeProposalReason("low confidence")).toBe("low confidence");
  });
});

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
    expect(llm.chat).toHaveBeenCalledTimes(3);
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

  it("stages a placeholder-bearing synthesis for review without the generated body", async () => {
    const llm = fakeNarrativeLLM({
      detect: {
        contradicted_claims: ["Phase 3 retrieval is planned."],
        net_new_facts: ["Something new happened."],
      },
      body: "Memory System will improve [specific areas of enhancement and testing] soon.",
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result.outcome).toBe("staged-for-review");
    expect(result.reason).toContain("unfilled template placeholder");
    expect(llm.chat).toHaveBeenCalledTimes(2);
    const staged = await readFile(join(tmp, "wiki", "compile-proposed", "memory-system.md"), "utf-8");
    // The Reason line quotes the placeholder; the staged compile-op body must
    // hold the current page text, never the generated placeholder body.
    const opBlock = /```compile-op\s*([\s\S]*?)```/m.exec(staged)?.[1];
    expect(opBlock).toBeDefined();
    const stagedOp = JSON.parse(opBlock!) as { body: string };
    expect(stagedOp.body).not.toContain("[specific areas of enhancement and testing]");
    expect(stagedOp.body).toContain("Memory System captures raw observations.");
  });

  it("bounds and redacts the staged review reason", async () => {
    const secret = `OPENROUTER_API_KEY=sk-live-${"a".repeat(40)}`;
    const staged = await stageNarrativeReview(
      tmp,
      "wiki/projects/memory-system.md",
      { reason: `unsupported claims: ${secret}; ${"details ".repeat(100)}`, facts: [] },
      new Date("2026-08-03T12:00:00.000Z"),
    );

    expect(staged.alreadyResolved).toBe(false);
    const content = await readFile(join(tmp, "wiki", "compile-proposed", "memory-system.md"), "utf-8");
    const reasonLine = content.split("\n").find((line) => line.startsWith("Reason: "));
    expect(reasonLine).toBeDefined();
    expect(reasonLine!.length).toBeLessThanOrEqual("Reason: ".length + 300);
    expect(content).not.toContain("sk-live-");
  });

  it("does not overwrite a concurrent edit with a relation-only update", async () => {
    await writeFileAt("wiki/tools/vitest.md", serializeFrontmatter({
      type: "tools",
      title: "Vitest",
      created: "2026-05-30",
      updated: "2026-05-30",
    }, "Vitest test runner.\n"));
    const concurrentlyEditedBody = "A human added this detail while synthesis was running.\n";
    const llm: LLMProvider = {
      providerName: "test",
      modelName: "test",
      chat: vi.fn(async (request: LLMRequest): Promise<LLMResponse> => {
        expect(request.jsonSchema?.name).toBe("NarrativeDetectOutput");
        await writePage("wiki/projects/memory-system.md", concurrentlyEditedBody);
        return fakeResponse(JSON.stringify({ contradicted_claims: [], net_new_facts: [] }));
      }),
    };

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: relationFacts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "staged-for-review",
      proposed: true,
      reason: expect.stringMatching(/source page changed/),
    });
    const written = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(written.body.trim()).toBe(concurrentlyEditedBody.trim());
    expect(written.frontmatter.relations).toBeUndefined();
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
      body: "Memory System graph coverage is tested with Vitest. Phase 3 retrieval is planned. [[docs/ROADMAP]] tracks rollout decisions.",
    });

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: relationFacts(),
      llm,
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    const parsed = parseFrontmatter(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8"));
    expect(result).toMatchObject({ outcome: "rewritten", proposed: false });
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

  it("does not treat distinct no-body safety-gate reviews as the same ledger key", async () => {
    const { recordProposalResolved } = await import("../../src/compile/proposal-ledger.js");
    const { hashNarrativeReviewPacket, NARRATIVE_REVIEW_KEY_FIELD } = await import(
      "../../src/compile/synthesize-narrative.js"
    );
    const manyClaimsA = Array.from({ length: 10 }, (_, i) => `Claim A${i}.`);
    const manyClaimsB = Array.from({ length: 10 }, (_, i) => `Claim B${i}.`);
    const pageBody = [
      "Memory System captures raw observations.",
      "",
      "## 2026-05-30 update",
      "",
      "- Phase 3 retrieval is planned.",
      "- [[docs/ROADMAP]] tracks the rollout.",
    ].join("\n");

    // Resolve only the first safety-gate fingerprint (claims A).
    await recordProposalResolved(
      tmp,
      {
        kind: "rewrite_page",
        path: "wiki/projects/memory-system.md",
        body: pageBody.trim(),
        frontmatter: {
          [NARRATIVE_REVIEW_KEY_FIELD]: hashNarrativeReviewPacket({
            reason: "too many contradicted claims for automatic rewrite",
            contradicted_claims: manyClaimsA,
            net_new_facts: [],
            facts: facts(),
          }),
        },
      },
      "rejected",
    );

    const resolvedAgain = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: manyClaimsA, net_new_facts: [] },
        body: "unused",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });
    expect(resolvedAgain).toMatchObject({
      proposed: false,
      proposalAlreadyResolved: true,
    });

    const differentClaims = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: manyClaimsB, net_new_facts: ["Something new."] },
        body: "unused",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });
    expect(differentClaims).toMatchObject({
      outcome: "staged-for-review",
      proposed: true,
      proposedPath: "wiki/compile-proposed/memory-system.md",
    });
    const proposal = await readFile(join(tmp, "wiki", "compile-proposed", "memory-system.md"), "utf-8");
    expect(proposal).toContain(NARRATIVE_REVIEW_KEY_FIELD);
    expect(proposal).toContain(hashNarrativeReviewPacket({
      reason: "too many contradicted claims for automatic rewrite",
      contradicted_claims: manyClaimsB,
      net_new_facts: ["Something new."],
      facts: facts(),
    }));
  });

  it("distinguishes no-body reviews that share claim lists but differ in source facts", async () => {
    const { hashNarrativeReviewPacket } = await import("../../src/compile/synthesize-narrative.js");
    const manyClaims = Array.from({ length: 10 }, (_, i) => `Shared claim ${i}.`);
    const reason = "too many contradicted claims for automatic rewrite";
    const factsA = facts().map((fact, index) => ({
      ...fact,
      fact_id: `f_${index}`,
      fact: {
        ...fact.fact,
        narrative: `Source A narrative ${index}`,
        sourceRawPath: `raw/2026-06-01/session-a.md`,
        sessionId: "session-a",
      },
      text: `Source A narrative ${index}`,
    }));
    const factsB = facts().map((fact, index) => ({
      ...fact,
      fact_id: `f_${index}`,
      fact: {
        ...fact.fact,
        narrative: `Source B narrative ${index}`,
        sourceRawPath: `raw/2026-06-02/session-b.md`,
        sessionId: "session-b",
      },
      text: `Source B narrative ${index}`,
    }));

    expect(hashNarrativeReviewPacket({
      reason,
      contradicted_claims: manyClaims,
      net_new_facts: [],
      facts: factsA,
    })).not.toBe(hashNarrativeReviewPacket({
      reason,
      contradicted_claims: manyClaims,
      net_new_facts: [],
      facts: factsB,
    }));
  });

  it("ignores observedAt when fingerprinting review source facts", async () => {
    const { hashNarrativeReviewPacket } = await import("../../src/compile/synthesize-narrative.js");
    const manyClaims = Array.from({ length: 10 }, (_, i) => `Shared claim ${i}.`);
    const reason = "too many contradicted claims for automatic rewrite";
    const baseFacts = facts().map((fact, index) => ({
      ...fact,
      fact_id: `f_${index}`,
      fact: {
        ...fact.fact,
        narrative: `Stable narrative ${index}`,
        sourceRawPath: "raw/2026-06-01/session.md",
        sessionId: "session",
        observedAt: "2026-06-01T10:00:00.000Z",
      },
    }));
    const laterFacts = baseFacts.map((fact) => ({
      ...fact,
      fact: {
        ...fact.fact,
        observedAt: "2026-06-02T10:00:00.000Z",
      },
    }));

    expect(hashNarrativeReviewPacket({
      reason,
      contradicted_claims: manyClaims,
      net_new_facts: [],
      facts: baseFacts,
    })).toBe(hashNarrativeReviewPacket({
      reason,
      contradicted_claims: manyClaims,
      net_new_facts: [],
      facts: laterFacts,
    }));
  });

  it("does not delete an unrelated pending draft when a resolved review re-runs", async () => {
    const { recordProposalResolved } = await import("../../src/compile/proposal-ledger.js");
    const { hashNarrativeReviewPacket, NARRATIVE_REVIEW_KEY_FIELD } = await import(
      "../../src/compile/synthesize-narrative.js"
    );
    const manyClaims = Array.from({ length: 10 }, (_, i) => `Claim A${i}.`);
    const pageBody = [
      "Memory System captures raw observations.",
      "",
      "## 2026-05-30 update",
      "",
      "- Phase 3 retrieval is planned.",
      "- [[docs/ROADMAP]] tracks the rollout.",
    ].join("\n");
    const reason = "too many contradicted claims for automatic rewrite";
    const reviewKey = hashNarrativeReviewPacket({
      reason,
      contradicted_claims: manyClaims,
      net_new_facts: [],
      facts: facts(),
    });

    await recordProposalResolved(
      tmp,
      {
        kind: "rewrite_page",
        path: "wiki/projects/memory-system.md",
        body: pageBody.trim(),
        frontmatter: { [NARRATIVE_REVIEW_KEY_FIELD]: reviewKey },
      },
      "rejected",
    );

    // Unrelated pending draft already in the basename slot (different body/key).
    await mkdir(join(tmp, "wiki", "compile-proposed"), { recursive: true });
    await writeFile(
      join(tmp, "wiki", "compile-proposed", "memory-system.md"),
      [
        "---",
        "type: references",
        "title: other draft",
        "---",
        "",
        "```compile-op",
        JSON.stringify({
          kind: "rewrite_page",
          path: "wiki/projects/memory-system.md",
          body: "A different pending narrative rewrite.",
          frontmatter: { [NARRATIVE_REVIEW_KEY_FIELD]: "other-pending-key" },
        }, null, 2),
        "```",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: manyClaims, net_new_facts: [] },
        body: "unused",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      proposed: false,
      proposalAlreadyResolved: true,
    });
    const stillThere = await readFile(join(tmp, "wiki", "compile-proposed", "memory-system.md"), "utf-8");
    expect(stillThere).toContain("A different pending narrative rewrite.");
    expect(stillThere).toContain("other-pending-key");
  });

  it("omits proposedPath when the narrative proposal was already resolved", async () => {
    const { recordProposalResolved } = await import("../../src/compile/proposal-ledger.js");
    const body = ["Memory System detail.", "", "- structured bullet"].join("\n");
    await recordProposalResolved(
      tmp,
      {
        kind: "rewrite_page",
        path: "wiki/projects/memory-system.md",
        body: body.trim(),
        frontmatter: {},
      },
      "rejected",
    );

    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: [], net_new_facts: ["New detail."] },
        body,
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      outcome: "staged-for-review",
      proposed: false,
      proposalAlreadyResolved: true,
    });
    expect(result.proposedPath).toBeUndefined();
    expect(existsSync(join(tmp, "wiki", "compile-proposed", "memory-system.md"))).toBe(false);
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

  it("stages truncated novelty detection output without changing canonical data", async () => {
    const before = await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8");
    const result = await synthesizeNarrative({
      vaultRoot: tmp,
      pageRelPath: "wiki/projects/memory-system.md",
      facts: facts(),
      llm: fakeNarrativeLLM({
        detect: { contradicted_claims: [], net_new_facts: [] },
        body: "unused",
        detectFinishReason: "length",
      }),
      now: new Date("2026-06-01T10:00:00.000Z"),
    });
    expect(result).toMatchObject({ outcome: "staged-for-review", reason: expect.stringMatching(/truncated.*length/) });
    expect(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8")).toBe(before);
  });

  it("stages filtered synthesis output without changing canonical data", async () => {
    const before = await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8");
    const result = await synthesizeNarrative({
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
    });
    expect(result).toMatchObject({ outcome: "staged-for-review", reason: expect.stringMatching(/truncated.*filter/) });
    expect(await readFile(join(tmp, "wiki", "projects", "memory-system.md"), "utf-8")).toBe(before);
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
  faithfulness?: { unsupported_claims: string[] } | string;
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
    if (request.jsonSchema?.name === "FaithfulnessOutput") {
      return fakeResponse(typeof opts.faithfulness === "string" ? opts.faithfulness : JSON.stringify(opts.faithfulness ?? { unsupported_claims: [] }));
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
