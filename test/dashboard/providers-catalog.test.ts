import { describe, expect, it } from "vitest";
import { buildProvidersCatalog } from "../../src/dashboard/providers-catalog.js";

describe("providers catalog", () => {
  it("returns embedders and llms with env status but no secret values", () => {
    const catalog = buildProvidersCatalog({
      VOYAGE_API_KEY: "voyage-secret",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "openrouter-secret",
      OLLAMA_HOST: "http://localhost:11434",
    });

    expect(catalog.embedders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "voyage",
          envVar: "VOYAGE_API_KEY",
          envVarStatus: "set",
          models: expect.arrayContaining([
            expect.objectContaining({ id: "voyage-4-large", dim: 2048, default: true }),
          ]),
        }),
        expect.objectContaining({
          provider: "openai",
          envVar: "OPENAI_API_KEY",
          envVarStatus: "missing",
        }),
        expect.objectContaining({
          provider: "ollama",
          envVar: "OLLAMA_HOST",
          envVarStatus: "set",
        }),
      ]),
    );
    expect(catalog.llms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openrouter",
          envVar: "OPENROUTER_API_KEY",
          envVarStatus: "set",
          models: expect.arrayContaining([
            expect.objectContaining({ id: "openai/gpt-4o-mini", default: true, free: false }),
          ]),
        }),
        expect.objectContaining({
          provider: "ollama",
          envVar: "OLLAMA_HOST",
          envVarStatus: "set",
        }),
      ]),
    );

    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toContain("voyage-secret");
    expect(serialized).not.toContain("openrouter-secret");
  });
});
