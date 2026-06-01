import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyQuery,
  classifyQueryHeuristic,
  isIntentLabel,
  type IntentLabel,
} from "../../src/retrieval/query-intent.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("query intent classification", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "query-intent-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it.each([
    ["how do I deploy the dashboard", "procedure"],
    ["what did we decide about embeddings", "decision"],
    ["why did we choose Voyage over OpenAI", "decision"],
    ["when did we add prospective memory", "episodic"],
    ["what does the user prefer about reranking", "preference"],
    ["what is the status right now", "current-truth"],
    ["where is the code implementation for consolidate", "code-context"],
    ["dashboard crashes with an exception", "procedure"],
  ] as Array<[string, IntentLabel]>)(
    "classifies obvious query %j as %s without LLM",
    (query, label) => {
      const result = classifyQueryHeuristic(query);

      expect(result).toMatchObject({
        label,
        method: "heuristic",
      });
      expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
    },
  );

  it("is case-insensitive and returns null for ambiguous queries", () => {
    expect(classifyQueryHeuristic("HOW DO I DEPLOY")).toMatchObject({
      label: "procedure",
    });
    expect(classifyQueryHeuristic("voyage embeddings")).toBeNull();
  });

  it("falls back to LLM for ambiguous queries and audits the call", async () => {
    const llm = fakeLLM("current-truth", { prompt: 8, completion: 1, total: 9 });

    const result = await classifyQuery({
      query: "vault status",
      llm,
      vaultRoot: tmp,
      env: {},
    });

    expect(result).toMatchObject({
      label: "current-truth",
      method: "llm",
      confidence: 0.75,
      tokensUsed: 9,
      tokensIn: 8,
      tokensOut: 1,
    });
    expect(llm.chat).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 8,
      temperature: 0,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "system", content: expect.stringContaining("decision") }),
        expect.objectContaining({ role: "user", content: "Query: vault status" }),
      ]),
    }));
  });

  it("does not spend an LLM call on simple keyword lookup queries", async () => {
    const llm = fakeLLM("current-truth");

    const result = await classifyQuery({
      query: "consolidation architecture",
      llm,
      vaultRoot: tmp,
      env: {},
    });

    expect(result).toMatchObject({
      label: "open-ended",
      method: "heuristic",
    });
    expect(result.confidence).toBeLessThan(0.7);
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("returns open-ended for malformed LLM responses", async () => {
    const result = await classifyQuery({
      query: "vault status",
      llm: fakeLLM("not-a-bucket"),
      vaultRoot: tmp,
      env: {},
    });

    expect(result).toMatchObject({
      label: "open-ended",
      method: "fallback",
      confidence: 0.5,
    });
  });

  it("honors MEMORY_LLM_DISABLED by taking the uniform fallback path", async () => {
    const llm = fakeLLM("procedure");

    const result = await classifyQuery({
      query: "how do I deploy the dashboard",
      llm,
      vaultRoot: tmp,
      env: { MEMORY_LLM_DISABLED: "true" },
    });

    expect(result).toMatchObject({
      label: "open-ended",
      method: "fallback",
      confidence: 0.5,
    });
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it("recognizes exactly the supported intent labels", () => {
    expect(["decision", "procedure", "episodic", "preference", "current-truth", "code-context", "open-ended"].every(isIntentLabel)).toBe(true);
    expect(isIntentLabel("other")).toBe(false);
  });
});

function fakeLLM(content: string, tokensUsed?: { prompt: number; completion: number; total: number }): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      content,
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      tokensUsed,
    })),
  };
}
