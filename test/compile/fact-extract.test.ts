import { describe, expect, it, vi } from "vitest";
import { extractEntityFacts } from "../../src/compile/fact-extract.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("extractEntityFacts", () => {
  it("extracts concise entity-scoped facts without transcript noise", async () => {
    const llm = fakeFactLLM([
      "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      "Memory System dashboard added manual compile execution and staged inbox links.",
      "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
    ]);

    const result = await extractEntityFacts({
      rawText: [
        "Prompt: assess iAqar UX. Mention Memory System only as context.",
        "Tool output: 200 unrelated lines of UX copy that must not be preserved verbatim.",
        "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      ].join("\n"),
      entity: "Memory System",
      entityContext: "wiki/projects/memory-system.md",
      llm,
      maxBytes: 20_000,
    });

    expect(result.facts).toEqual([
      "Memory System shipped Phase 3 retrieval with BM25, vector, graph, and metadata fusion.",
      "Memory System dashboard added manual compile execution and staged inbox links.",
    ]);
    expect(llm.chat).toHaveBeenCalledOnce();
    const prompt = vi.mocked(llm.chat).mock.calls[0]![0].messages.at(-1)!.content;
    expect(prompt).toContain("extract only concrete, durable facts about Memory System");
    expect(result.facts.join("\n")).not.toContain("200 unrelated lines");
  });

  it("returns an empty fact list for tangential entity mentions", async () => {
    const llm = fakeFactLLM([]);

    const result = await extractEntityFacts({
      rawText: "The iAqar UX prompt name-dropped Memory System but made no Memory System decision or status change.",
      entity: "Memory System",
      llm,
      maxBytes: 20_000,
    });

    expect(result.facts).toEqual([]);
  });
});

function fakeFactLLM(facts: string[]): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      tokensUsed: { prompt: 11, completion: 7, total: 18 },
      content: [
        "```json",
        JSON.stringify({ facts }),
        "```",
      ].join("\n"),
    })),
  };
}
