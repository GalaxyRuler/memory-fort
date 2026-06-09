import { describe, it, expect } from "vitest";
import { createLLMFromConfig, getActiveLLMConfig } from "../../src/llm/factory.js";

describe("LLM factory — openai-compat", () => {
  it("getActiveLLMConfig parses openai-compat", () => {
    const config = {
      llm: {
        provider: "openai-compat",
        model: "mistral",
        options: { baseURL: "http://localhost:11434/v1" },
        allow_internal_hosts: true,
      },
    };
    const result = getActiveLLMConfig(config);
    expect(result?.provider).toBe("openai-compat");
    expect(result?.options?.["baseURL"]).toBe("http://localhost:11434/v1");
    expect(result?.allowInternalHosts).toBe(true);
  });

  it("createLLMFromConfig creates openai-compat provider", () => {
    const llm = createLLMFromConfig({
      provider: "openai-compat",
      model: "mistral",
      options: { baseURL: "http://localhost:11434/v1" },
      allowInternalHosts: true,
    }, {});
    expect(llm.providerName).toBe("openai-compat");
    expect(llm.modelName).toBe("mistral");
  });

  it("throws LLMConfigError if baseURL missing", () => {
    expect(() => createLLMFromConfig({
      provider: "openai-compat",
      allowInternalHosts: true,
    }, {})).toThrow("baseURL");
  });

  it("throws LLMConfigError if localhost without allow_internal_hosts", () => {
    expect(() => createLLMFromConfig({
      provider: "openai-compat",
      options: { baseURL: "http://localhost:11434/v1" },
    }, {})).toThrow("allow_internal_hosts");
  });
});
