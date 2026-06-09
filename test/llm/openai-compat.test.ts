import { describe, it, expect, vi } from "vitest";
import { createOpenAICompatLLM } from "../../src/llm/openai-compat.js";

describe("createOpenAICompatLLM", () => {
  it("chat returns assistant content", async () => {
    const fakeCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      model: "llama3.2",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const llm = createOpenAICompatLLM(
      { baseURL: "http://localhost:11434/v1", model: "llama3.2" },
      { chat: { completions: { create: fakeCreate } } } as never,
    );
    const result = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(result.rawProviderName).toBe("openai-compat");
  });

  it("providerName and modelName are set", () => {
    const llm = createOpenAICompatLLM(
      { baseURL: "http://localhost:11434/v1", model: "mistral" },
      { chat: { completions: { create: vi.fn() } } } as never,
    );
    expect(llm.providerName).toBe("openai-compat");
    expect(llm.modelName).toBe("mistral");
  });

  it("captures token usage", async () => {
    const fakeCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      model: "m",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const llm = createOpenAICompatLLM(
      { baseURL: "http://localhost:11434/v1" },
      { chat: { completions: { create: fakeCreate } } } as never,
    );
    const result = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(result.tokensUsed).toEqual({ prompt: 10, completion: 5, total: 15 });
  });

  it("wraps API errors in LLMConfigError", async () => {
    const fakeCreate = vi.fn().mockRejectedValue(new Error("connection refused"));
    const llm = createOpenAICompatLLM(
      { baseURL: "http://localhost:11434/v1" },
      { chat: { completions: { create: fakeCreate } } } as never,
    );
    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("connection refused");
  });

  it("maps finish reasons correctly", async () => {
    for (const [raw, expected] of [
      ["stop", "stop"],
      ["length", "length"],
      ["content_filter", "filter"],
      ["tool_calls", "tool_calls"],
      ["unknown_value", "other"],
    ] as const) {
      const fakeCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: "" }, finish_reason: raw }],
        model: "m",
      });
      const llm = createOpenAICompatLLM(
        { baseURL: "http://localhost:11434/v1" },
        { chat: { completions: { create: fakeCreate } } } as never,
      );
      const result = await llm.chat({ messages: [{ role: "user", content: "hi" }] });
      expect(result.finishReason).toBe(expected);
    }
  });
});
