import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterLLM } from "../../src/llm/openrouter.js";

const openai = vi.hoisted(() => ({
  constructor: vi.fn(),
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation((options: unknown) => {
    openai.constructor(options);
    return { chat: { completions: { create: openai.create } } };
  }),
}));

describe("OpenRouter LLM provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses OpenRouter through the OpenAI SDK and normalizes responses", async () => {
    openai.create.mockResolvedValue({
      model: "openai/gpt-4o-mini",
      choices: [{
        message: { content: "pong" },
        finish_reason: "content_filter",
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
    });
    const llm = createOpenRouterLLM({ apiKey: "test-key" });

    await expect(llm.chat({
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    })).resolves.toEqual({
      content: "pong",
      model: "openai/gpt-4o-mini",
      tokensUsed: { prompt: 3, completion: 1, total: 4 },
      finishReason: "filter",
      rawProviderName: "openrouter",
    });
    expect(openai.constructor).toHaveBeenCalledWith({
      apiKey: "test-key",
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/GalaxyRuler/memory-fort",
        "X-Title": "Memory Fort",
      },
    });
    expect(openai.create).toHaveBeenCalledWith(
      {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        max_tokens: 4096,
        temperature: 0.2,
        usage: { include: true },
      },
      { signal: undefined },
    );
  });

  it("surfaces no-choice responses as errors", async () => {
    openai.create.mockResolvedValue({ choices: [] });
    const llm = createOpenRouterLLM({ apiKey: "test-key" });

    await expect(llm.chat({ messages: [{ role: "user", content: "hi" }] }))
      .rejects.toThrow("OpenRouter returned no choices");
  });

  it("requests usage details and surfaces OpenRouter response cost", async () => {
    openai.create.mockResolvedValue({
      model: "google/gemini-2.5-flash-lite",
      choices: [{
        message: { content: "pong" },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
        cost: 0.0123,
      },
    });
    const llm = createOpenRouterLLM({
      apiKey: "test-key",
      model: "google/gemini-2.5-flash-lite",
    });

    const result = await llm.chat({
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });

    expect(result.tokensUsed).toEqual({
      prompt: 3,
      completion: 1,
      total: 4,
      costUsd: 0.0123,
    });
    expect(openai.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: { include: true },
      }),
      { signal: undefined },
    );
  });
});
