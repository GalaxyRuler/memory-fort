import { describe, expect, it } from "vitest";
import { estimateLLMCostUsd } from "../../src/llm/pricing.js";

describe("LLM pricing", () => {
  it("estimates fallback cost for OpenRouter Gemini 2.5 Flash Lite", () => {
    const cost = estimateLLMCostUsd({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });

    expect(cost).toBeGreaterThan(0);
  });
});
