import { describe, expect, it } from "vitest";
import {
  createLLMFromConfig,
  getActiveLLMConfig,
  listLLMProviders,
} from "../../src/llm/factory.js";
import { LLMConfigError, LLMDisabledError } from "../../src/llm/types.js";

describe("LLM factory", () => {
  it("returns null active config when llm section is absent", () => {
    expect(getActiveLLMConfig({})).toBeNull();
  });

  it("reads llm provider config", () => {
    expect(getActiveLLMConfig({
      llm: {
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
        max_tokens: 1024,
        temperature: 0.1,
      },
    })).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      max_tokens: 1024,
      temperature: 0.1,
    });
  });

  it("throws clear errors for missing config, missing key, and kill switch", () => {
    expect(() => createLLMFromConfig(null, {})).toThrow("no `llm:` section");
    expect(() => createLLMFromConfig({ provider: "openrouter" }, {}))
      .toThrow("OPENROUTER_API_KEY not set");
    expect(() => createLLMFromConfig(
      { provider: "ollama" },
      { MEMORY_LLM_DISABLED: "true" },
    )).toThrow(LLMDisabledError);
  });

  it("creates Ollama without a key", () => {
    const llm = createLLMFromConfig({ provider: "ollama", model: "llama3.2" }, {});

    expect(llm.providerName).toBe("ollama");
    expect(llm.modelName).toBe("llama3.2");
  });

  it("rejects unknown llm providers", () => {
    expect(() => getActiveLLMConfig({
      llm: { provider: "anthropic" },
    })).toThrow(LLMConfigError);
  });

  it("lists provider metadata and active status", () => {
    expect(listLLMProviders(
      { provider: "ollama", model: "llama3.2" },
      { OLLAMA_HOST: "http://localhost:11434" },
    )).toEqual([
      expect.objectContaining({ provider: "openrouter", requiredEnv: "OPENROUTER_API_KEY", active: false }),
      expect.objectContaining({ provider: "ollama", requiredEnv: "OLLAMA_HOST", active: true, keyAvailable: true }),
    ]);
  });
});
