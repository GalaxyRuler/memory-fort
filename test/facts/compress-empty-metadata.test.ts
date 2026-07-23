import { describe, expect, it, vi } from "vitest";
import { compressSession } from "../../src/facts/compress.js";
import type { LLMProvider } from "../../src/llm/types.js";

describe("deterministically empty compression sources", () => {
  it("permits an empty fact bundle only for metadata with no durable source text", async () => {
    const llm: LLMProvider = {
      providerName: "ollama",
      modelName: "llama3.2",
      chat: vi.fn(async () => ({
        model: "llama3.2",
        finishReason: "stop" as const,
        rawProviderName: "ollama",
        content: JSON.stringify({ facts: [] }),
      })),
    };

    await expect(compressSession({
      rawText: "---\ntype: raw-session\nsession: x\n---\n## [10:00:00] Prompt\n",
      rawRelPath: "raw/2026-07-17/x.md",
      sessionId: "x",
      observedAt: "2026-07-17T00:00:00.000Z",
      llm,
    })).resolves.toEqual([]);
  });
});
