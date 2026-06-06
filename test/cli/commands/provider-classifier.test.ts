import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatTestClassifierResult,
  runTestClassifier,
} from "../../../src/cli/commands/provider.js";
import type { LLMProvider } from "../../../src/llm/types.js";

describe("provider classifier command", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "provider-classifier-"));
    await mkdir(join(tmp, "wiki"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("classifies obvious queries without creating an LLM provider", async () => {
    const result = await runTestClassifier({
      query: "how do I deploy the dashboard",
      memoryRoot: tmp,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: vi.fn(() => fakeLLM("decision")),
      env: {},
      nowMs: (() => {
        const values = [10, 12];
        return () => values.shift() ?? 12;
      })(),
    });

    expect(result).toMatchObject({
      exitCode: 0,
      query: "how do I deploy the dashboard",
      label: "procedure",
      method: "heuristic",
      costUsd: 0,
    });
    expect(formatTestClassifierResult(result)).toContain("Label: procedure");
    expect(formatTestClassifierResult(result)).toContain("Cost: $0.00");
  });

  it("uses the configured LLM for ambiguous queries", async () => {
    const result = await runTestClassifier({
      query: "vault status",
      memoryRoot: tmp,
      configLoader: async () => ({ llm: { provider: "ollama", model: "llama3.2" } }),
      llmFactory: () => fakeLLM("current-truth"),
      env: {},
      nowMs: () => 100,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      label: "current-truth",
      method: "llm",
      costUsd: 0.0001,
    });
    expect(formatTestClassifierResult(result)).toContain("Tokens:");
  });
});

function fakeLLM(content: string): LLMProvider {
  return {
    providerName: "ollama",
    modelName: "llama3.2",
    chat: vi.fn(async () => ({
      content,
      model: "llama3.2",
      finishReason: "stop",
      rawProviderName: "ollama",
      tokensUsed: { prompt: 8, completion: 1, total: 9 },
    })),
  };
}
