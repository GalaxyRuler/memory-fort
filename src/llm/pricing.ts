export interface LLMPricing {
  promptPerMTok: number;
  completionPerMTok: number;
}

const PRICING: Record<string, LLMPricing> = {
  "openrouter/openai/gpt-4o-mini": {
    promptPerMTok: 0.15,
    completionPerMTok: 0.60,
  },
  "openrouter/google/gemini-3.1-flash-lite-preview": {
    promptPerMTok: 0.25,
    completionPerMTok: 1.50,
  },
  "google/google/gemini-3.1-flash-lite-preview": {
    promptPerMTok: 0.25,
    completionPerMTok: 1.50,
  },
};

export function lookupLLMPricing(provider: string, model: string): LLMPricing | null {
  const normalizedProvider = provider.trim().toLowerCase();
  if (normalizedProvider === "ollama") {
    return { promptPerMTok: 0, completionPerMTok: 0 };
  }

  return PRICING[`${normalizedProvider}/${model.trim().toLowerCase()}`] ?? null;
}

export function estimateLLMCostUsd(input: {
  provider: string;
  model: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}): number | null {
  if (input.provider.trim().toLowerCase() === "ollama") return 0;

  const pricing = lookupLLMPricing(input.provider, input.model);
  if (!pricing) return null;
  if (
    typeof input.tokensIn !== "number" ||
    typeof input.tokensOut !== "number" ||
    !Number.isFinite(input.tokensIn) ||
    !Number.isFinite(input.tokensOut)
  ) {
    return null;
  }

  return (
    input.tokensIn / 1_000_000 * pricing.promptPerMTok +
    input.tokensOut / 1_000_000 * pricing.completionPerMTok
  );
}
