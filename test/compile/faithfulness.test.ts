import { describe, it, expect, vi } from "vitest";
import { assessClaimSupport } from "../../src/compile/faithfulness.js";
import type { LLMProvider } from "../../src/llm/types.js";

function fakeLLM(content: string): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake-model",
    chat: vi.fn(async () => ({
      content,
      model: "fake-model",
      finishReason: "stop",
      rawProviderName: "fake",
    })),
  };
}

function fakeFaithfulnessLLM(payload: { unsupported_claims: string[] }): LLMProvider {
  return fakeLLM(JSON.stringify(payload));
}

function fakeTruncatedLLM(content: string): LLMProvider {
  return {
    providerName: "fake",
    modelName: "fake-model",
    chat: vi.fn(async () => ({
      content,
      model: "fake-model",
      finishReason: "length" as const,
      rawProviderName: "fake",
    })),
  };
}

describe("assessClaimSupport", () => {
  it("returns supported=true when no unsupported claims", async () => {
    const llm = fakeFaithfulnessLLM({ unsupported_claims: [] });
    const r = await assessClaimSupport({
      body: "FamTree exists.",
      facts: [{ fact_id: "f_0", narrative: "FamTree project directory exists." }],
      llm,
    });
    expect(r.supported).toBe(true);
    expect(r.unsupportedClaims).toEqual([]);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(llm.chat).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 0,
      jsonSchema: expect.objectContaining({
        name: "FaithfulnessOutput",
        strict: true,
        schema: expect.objectContaining({
          properties: expect.objectContaining({
            unsupported_claims: expect.any(Object),
          }),
          required: expect.arrayContaining(["unsupported_claims"]),
        }),
      }),
    }));
  });

  it("flags unsupported claims", async () => {
    const llm = fakeFaithfulnessLLM({ unsupported_claims: ["Built with Supabase", "e2e tests passing"] });
    const r = await assessClaimSupport({
      body: "FamTree is built with Supabase and e2e tests are passing.",
      facts: [{ fact_id: "f_0", narrative: "FamTree directory is empty, no git." }],
      llm,
    });
    expect(r.supported).toBe(false);
    expect(r.unsupportedClaims).toHaveLength(2);
  });

  it("treats empty facts as supporting nothing concrete", async () => {
    const llm = fakeFaithfulnessLLM({ unsupported_claims: ["Built with Supabase"] });
    const r = await assessClaimSupport({ body: "Built with Supabase.", facts: [], llm });
    expect(r.supported).toBe(false);
  });

  it("fails open when the LLM returns malformed JSON", async () => {
    const llm = fakeLLM("not json");
    const r = await assessClaimSupport({
      body: "FamTree is built with Supabase.",
      facts: [{ fact_id: "f_0", narrative: "FamTree project directory exists." }],
      llm,
    });

    expect(r.supported).toBe(true);
    expect(r.unsupportedClaims).toEqual([]);
  });

  it("stages (supported=false) when the judge response is truncated", async () => {
    // Truncated JSON would also fail to parse — but the truncation guard must fire FIRST,
    // so this must NOT fail open to supported=true.
    const llm = fakeTruncatedLLM('{"unsupported_claims": [');
    const r = await assessClaimSupport({
      body: "FamTree is built with Supabase and the e2e suite passes.",
      facts: [{ fact_id: "f_0", narrative: "FamTree directory is empty, no git." }],
      llm,
    });
    expect(r.supported).toBe(false);
    expect(r.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it("passes the prior page body to the judge as established context", async () => {
    // Synthesis preserves existing substantive content, so claims carried over
    // from the prior page must not be judged unsupported just because they are
    // absent from this pass's small fact batch.
    const llm = fakeFaithfulnessLLM({ unsupported_claims: [] });
    await assessClaimSupport({
      body: "FamTree is built with Supabase and ships an Arabic UI.",
      facts: [{ fact_id: "f_0", narrative: "FamTree ships an Arabic UI." }],
      priorBody: "FamTree is built with Supabase.",
      llm,
    });
    const call = vi.mocked(llm.chat).mock.calls[0]![0];
    const userMessage = call.messages.find((message) => message.role === "user")?.content ?? "";
    expect(userMessage).toContain("PRIOR PAGE");
    expect(userMessage).toContain("FamTree is built with Supabase.");
  });
});
