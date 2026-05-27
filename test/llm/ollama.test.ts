import { afterEach, describe, expect, it, vi } from "vitest";
import { createOllamaLLM } from "../../src/llm/ollama.js";
import { LLMConfigError } from "../../src/llm/types.js";

describe("Ollama LLM provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts chat requests to Ollama and maps token counts", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({
        model: "llama3.2",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        options: { temperature: 0.2, num_predict: 4096 },
      });
      return new Response(JSON.stringify({
        model: "llama3.2",
        message: { role: "assistant", content: "pong" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 2,
        eval_count: 1,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchFn);
    const llm = createOllamaLLM({ host: "http://ollama.test" });

    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] }))
      .resolves.toEqual({
        content: "pong",
        model: "llama3.2",
        tokensUsed: { prompt: 2, completion: 1, total: 3 },
        finishReason: "length",
        rawProviderName: "ollama",
      });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://ollama.test/api/chat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces connection failures with the configured host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const llm = createOllamaLLM({ host: "http://missing.test" });

    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] }))
      .rejects.toBeInstanceOf(LLMConfigError);
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] }))
      .rejects.toThrow("OLLAMA_HOST unreachable: http://missing.test");
  });
});
