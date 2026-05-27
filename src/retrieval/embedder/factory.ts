import type { MemoryConfig } from "../../storage/config.js";
import { createOllamaEmbedder } from "./ollama.js";
import { createOpenAIEmbedder } from "./openai.js";
import { createVoyageEmbedder } from "./voyage.js";
import type { Embedder, EmbedderConfig, EmbedderProvider } from "./types.js";

export { type EmbedderConfig, type EmbedderProvider } from "./types.js";

export interface EmbedderProviderInfo {
  provider: EmbedderProvider;
  requiredEnv: "VOYAGE_API_KEY" | "OPENAI_API_KEY" | "OLLAMA_HOST";
  defaultModel: string;
  active: boolean;
  model: string;
  dim: number;
  keyAvailable: boolean;
}

export class EmbedderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedderConfigError";
  }
}

const DEFAULT_CONFIG: EmbedderConfig = {
  provider: "voyage",
  model: "voyage-4-large",
};

const PROVIDERS: Record<EmbedderProvider, {
  requiredEnv: EmbedderProviderInfo["requiredEnv"];
  defaultModel: string;
  dimByModel: Record<string, number>;
}> = {
  voyage: {
    requiredEnv: "VOYAGE_API_KEY",
    defaultModel: "voyage-4-large",
    dimByModel: { "voyage-4-large": 2048 },
  },
  openai: {
    requiredEnv: "OPENAI_API_KEY",
    defaultModel: "text-embedding-3-small",
    dimByModel: {
      "text-embedding-3-small": 1536,
      "text-embedding-3-large": 3072,
    },
  },
  ollama: {
    requiredEnv: "OLLAMA_HOST",
    defaultModel: "nomic-embed-text",
    dimByModel: {
      "nomic-embed-text": 768,
      "mxbai-embed-large": 1024,
      "all-minilm": 384,
    },
  },
};

export function createEmbedderFromConfig(
  config: EmbedderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Embedder {
  switch (config.provider) {
    case "voyage": {
      const apiKey = env["VOYAGE_API_KEY"]?.trim();
      if (!apiKey) throw new EmbedderConfigError("VOYAGE_API_KEY not set");
      return createVoyageEmbedder({ apiKey, model: config.model });
    }
    case "openai": {
      const apiKey = env["OPENAI_API_KEY"]?.trim();
      if (!apiKey) throw new EmbedderConfigError("OPENAI_API_KEY not set");
      return createOpenAIEmbedder({
        apiKey,
        model: config.model,
        baseURL: readString(config.options?.["baseURL"]),
      });
    }
    case "ollama":
      return createOllamaEmbedder({
        host: readString(config.options?.["host"]) ?? env["OLLAMA_HOST"],
        model: config.model,
      });
  }
}

export function getActiveEmbedderConfig(config: MemoryConfig): EmbedderConfig {
  const raw = asRecord(config.embedder) ?? asRecord(config.embedding);
  if (!raw) return { ...DEFAULT_CONFIG };

  const provider = readProvider(raw["provider"]);
  if (!provider) {
    throw new EmbedderConfigError(
      `unknown embedder provider: ${String(raw["provider"])}`,
    );
  }

  return {
    provider,
    model: readString(raw["model"]) ?? PROVIDERS[provider].defaultModel,
    options: asRecord(raw["options"]) ?? undefined,
  };
}

export function listEmbedderProviders(
  activeConfig: EmbedderConfig,
  env: NodeJS.ProcessEnv = process.env,
): EmbedderProviderInfo[] {
  return (["voyage", "openai", "ollama"] as const).map((provider) => {
    const metadata = PROVIDERS[provider];
    const model = activeConfig.provider === provider
      ? activeConfig.model ?? metadata.defaultModel
      : metadata.defaultModel;
    return {
      provider,
      requiredEnv: metadata.requiredEnv,
      defaultModel: metadata.defaultModel,
      active: activeConfig.provider === provider,
      model,
      dim: metadata.dimByModel[model] ?? Object.values(metadata.dimByModel)[0]!,
      keyAvailable: hasProviderCredential(provider, env),
    };
  });
}

export function estimateEmbeddingCostUsd(
  provider: EmbedderProvider,
  tokenEstimate: number,
): number {
  const perMillionTokens: Record<EmbedderProvider, number> = {
    voyage: 0.12,
    openai: 0.02,
    ollama: 0,
  };
  return (tokenEstimate / 1_000_000) * perMillionTokens[provider];
}

function hasProviderCredential(
  provider: EmbedderProvider,
  env: NodeJS.ProcessEnv,
): boolean {
  if (provider === "ollama") return true;
  return Boolean(env[PROVIDERS[provider].requiredEnv]?.trim());
}

function readProvider(value: unknown): EmbedderProvider | null {
  return value === "voyage" || value === "openai" || value === "ollama"
    ? value
    : null;
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
