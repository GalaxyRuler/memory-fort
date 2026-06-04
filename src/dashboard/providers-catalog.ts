import { OPENROUTER_CURATED_MODELS } from "../llm/openrouter-catalog.js";

export type EnvVarStatus = "set" | "missing";

export interface ProviderCatalogModel {
  id: string;
  default?: boolean;
  dim?: number;
  free?: boolean;
}

export interface ProviderCatalogEntry {
  provider: string;
  envVar: string;
  envVarStatus: EnvVarStatus;
  models: ProviderCatalogModel[];
}

export interface ProvidersCatalog {
  embedders: ProviderCatalogEntry[];
  llms: ProviderCatalogEntry[];
}

const EMBEDDER_MODELS: ProviderCatalogEntry[] = [
  {
    provider: "lexical",
    envVar: "none",
    envVarStatus: "set",
    models: [
      { id: "lexical", dim: 0, default: true },
    ],
  },
  {
    provider: "voyage",
    envVar: "VOYAGE_API_KEY",
    envVarStatus: "missing",
    models: [
      { id: "voyage-4-large", dim: 2048, default: true },
      { id: "voyage-3-large", dim: 1024 },
      { id: "voyage-3", dim: 1024 },
    ],
  },
  {
    provider: "openai",
    envVar: "OPENAI_API_KEY",
    envVarStatus: "missing",
    models: [
      { id: "text-embedding-3-small", dim: 1536, default: true },
      { id: "text-embedding-3-large", dim: 3072 },
    ],
  },
  {
    provider: "ollama",
    envVar: "OLLAMA_HOST",
    envVarStatus: "missing",
    models: [
      { id: "nomic-embed-text", dim: 768, default: true },
      { id: "mxbai-embed-large", dim: 1024 },
      { id: "all-minilm", dim: 384 },
    ],
  },
];

const LLM_MODELS: ProviderCatalogEntry[] = [
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    envVarStatus: "missing",
    models: OPENROUTER_CURATED_MODELS,
  },
  {
    provider: "ollama",
    envVar: "OLLAMA_HOST",
    envVarStatus: "missing",
    models: [
      { id: "llama3.2", default: true },
      { id: "llama3.1" },
      { id: "mistral" },
      { id: "qwen2.5" },
    ],
  },
];

export function buildProvidersCatalog(env: NodeJS.ProcessEnv = process.env): ProvidersCatalog {
  return {
    embedders: EMBEDDER_MODELS.map((provider) => withEnvStatus(provider, env)),
    llms: LLM_MODELS.map((provider) => withEnvStatus(provider, env)),
  };
}

function withEnvStatus(
  provider: ProviderCatalogEntry,
  env: NodeJS.ProcessEnv,
): ProviderCatalogEntry {
  return {
    ...provider,
    envVarStatus: provider.provider === "lexical" || provider.provider === "ollama"
      ? "set"
      : env[provider.envVar]?.trim() ? "set" : "missing",
    models: provider.models.map((model) => ({ ...model })),
  };
}
