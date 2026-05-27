import type { MemoryConfig } from "../storage/config.js";
import { createOllamaLLM } from "./ollama.js";
import { createOpenRouterLLM } from "./openrouter.js";
import { LLMConfigError, LLMDisabledError, type LLMProvider } from "./types.js";

export { LLMConfigError, LLMDisabledError } from "./types.js";

export type LLMProviderName = "openrouter" | "ollama";

export interface LLMConfig {
  provider: LLMProviderName;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  options?: Record<string, unknown>;
}

export interface LLMProviderInfo {
  provider: LLMProviderName;
  requiredEnv: "OPENROUTER_API_KEY" | "OLLAMA_HOST";
  defaultModel: string;
  active: boolean;
  model: string;
  keyAvailable: boolean;
}

const PROVIDERS: Record<LLMProviderName, {
  requiredEnv: LLMProviderInfo["requiredEnv"];
  defaultModel: string;
}> = {
  openrouter: {
    requiredEnv: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-4o-mini",
  },
  ollama: {
    requiredEnv: "OLLAMA_HOST",
    defaultModel: "llama3.2",
  },
};

export function getActiveLLMConfig(config: MemoryConfig): LLMConfig | null {
  const raw = asRecord(config.llm);
  if (!raw) return null;
  const provider = readProvider(raw["provider"]);
  if (!provider) {
    throw new LLMConfigError(`unknown llm provider: ${String(raw["provider"])}`);
  }
  return {
    provider,
    model: readString(raw["model"]) ?? PROVIDERS[provider].defaultModel,
    max_tokens: readNumber(raw["max_tokens"]),
    temperature: readNumber(raw["temperature"]),
    options: asRecord(raw["options"]) ?? undefined,
  };
}

export function createLLMFromConfig(
  config: LLMConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  if (env["MEMORY_LLM_DISABLED"]?.trim().toLowerCase() === "true") {
    throw new LLMDisabledError();
  }
  if (!config) {
    throw new LLMConfigError("no `llm:` section in ~/.memory/config.yaml");
  }

  switch (config.provider) {
    case "openrouter": {
      const apiKey = env["OPENROUTER_API_KEY"]?.trim();
      if (!apiKey) throw new LLMConfigError("OPENROUTER_API_KEY not set");
      return createOpenRouterLLM({
        apiKey,
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
      });
    }
    case "ollama":
      return createOllamaLLM({
        host: readString(config.options?.["host"]) ?? env["OLLAMA_HOST"],
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
      });
    default:
      throw new LLMConfigError(
        `unknown llm provider: ${String((config as { provider?: unknown }).provider)}`,
      );
  }
}

export function listLLMProviders(
  activeConfig: LLMConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): LLMProviderInfo[] {
  return (["openrouter", "ollama"] as const).map((provider) => {
    const metadata = PROVIDERS[provider];
    const model = activeConfig?.provider === provider
      ? activeConfig.model ?? metadata.defaultModel
      : metadata.defaultModel;
    return {
      provider,
      requiredEnv: metadata.requiredEnv,
      defaultModel: metadata.defaultModel,
      active: activeConfig?.provider === provider,
      model,
      keyAvailable: hasProviderCredential(provider, env),
    };
  });
}

function hasProviderCredential(provider: LLMProviderName, env: NodeJS.ProcessEnv): boolean {
  if (provider === "ollama") return true;
  return Boolean(env[PROVIDERS[provider].requiredEnv]?.trim());
}

function readProvider(value: unknown): LLMProviderName | null {
  return value === "openrouter" || value === "ollama" ? value : null;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
