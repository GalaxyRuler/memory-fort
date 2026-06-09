import type { MemoryConfig } from "../../storage/config.js";
import {
  classifyConfiguredOutboundUrl,
  classifyOpenAIBaseUrl,
  classifyOutboundUrl,
  getOutboundHttpUrlRejectionReason,
  normalizeOutboundHttpUrl,
} from "../../storage/url-safety.js";
import { createOllamaEmbedder } from "./ollama.js";
import { createOpenAIEmbedder } from "./openai.js";
import { createOpenAICompatEmbedder } from "./openai-compat.js";
import { createVoyageEmbedder } from "./voyage.js";
import type { Embedder, EmbedderConfig, EmbedderProvider } from "./types.js";

export { type EmbedderConfig, type EmbedderProvider } from "./types.js";

export interface EmbedderProviderInfo {
  provider: EmbedderProvider;
  requiredEnv: "none" | "VOYAGE_API_KEY" | "OPENAI_API_KEY" | "OLLAMA_HOST";
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
  provider: "lexical",
  model: "lexical",
};

const PROVIDERS: Record<EmbedderProvider, {
  requiredEnv: EmbedderProviderInfo["requiredEnv"];
  defaultModel: string;
  dimByModel: Record<string, number>;
}> = {
  lexical: {
    requiredEnv: "none",
    defaultModel: "lexical",
    dimByModel: { lexical: 0 },
  },
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
  "openai-compat": {
    requiredEnv: "none",
    defaultModel: "nomic-embed-text",
    dimByModel: {},
  },
};

export function createEmbedderFromConfig(
  config: EmbedderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Embedder {
  switch (config.provider) {
    case "lexical":
      return createLexicalEmbedder();
    case "voyage": {
      const apiKey = env["VOYAGE_API_KEY"]?.trim();
      if (!apiKey) throw new EmbedderConfigError("VOYAGE_API_KEY not set");
      return createVoyageEmbedder({ apiKey, model: config.model });
    }
    case "openai": {
      const apiKey = env["OPENAI_API_KEY"]?.trim();
      if (!apiKey) throw new EmbedderConfigError("OPENAI_API_KEY not set");
      const baseURL = readString(config.options?.["baseURL"]);
      if (baseURL) assertOfficialOpenAIBaseUrl(baseURL, "embedder baseURL");
      return createOpenAIEmbedder({
        apiKey,
        model: config.model,
        baseURL,
      });
    }
    case "ollama": {
      const configuredHost = readString(config.options?.["host"]);
      const envHost = readString(env["OLLAMA_HOST"]);
      const host = configuredHost
        ? assertConfiguredOutboundUrl(configuredHost, "OLLAMA host", config.allowInternalHosts === true)
        : envHost
          ? assertHttpUrl(envHost, "OLLAMA host")
          : undefined;
      return createOllamaEmbedder({
        host,
        model: config.model,
      });
    }
    case "openai-compat": {
      const baseURL = readString(config.options?.["baseURL"]);
      if (!baseURL) throw new EmbedderConfigError("openai-compat embedder requires options.baseURL");
      const dimRaw = config.options?.["dim"];
      const dim = typeof dimRaw === "number" && Number.isInteger(dimRaw) && dimRaw > 0 ? dimRaw : null;
      if (dim === null) throw new EmbedderConfigError("openai-compat embedder requires options.dim (integer > 0)");
      const validatedURL = assertConfiguredOutboundUrl(baseURL, "openai-compat baseURL", config.allowInternalHosts === true);
      const apiKey = readString(config.options?.["apiKey"]);
      return createOpenAICompatEmbedder({ baseURL: validatedURL, model: config.model, dim, apiKey });
    }
  }
}

export function getActiveEmbedderConfig(config: MemoryConfig): EmbedderConfig {
  const raw = asRecord(config.embedder) ?? asRecord(config.embedding);
  if (!raw) return { ...DEFAULT_CONFIG };

  const provider = raw["provider"] === undefined
    ? DEFAULT_CONFIG.provider
    : readProvider(raw["provider"]);
  if (!provider) {
    throw new EmbedderConfigError(
      `unknown embedder provider: ${String(raw["provider"])}`,
    );
  }

  const result: EmbedderConfig = {
    provider,
    model: readString(raw["model"]) ?? PROVIDERS[provider].defaultModel,
  };
  const options = asRecord(raw["options"]);
  if (options) result.options = options;
  if (raw["allow_internal_hosts"] === true) result.allowInternalHosts = true;
  return result;
}

export function listEmbedderProviders(
  activeConfig: EmbedderConfig,
  env: NodeJS.ProcessEnv = process.env,
): EmbedderProviderInfo[] {
  return (["lexical", "voyage", "openai", "ollama", "openai-compat"] as const).map((provider) => {
    const metadata = PROVIDERS[provider];
    const model = activeConfig.provider === provider
      ? activeConfig.model ?? metadata.defaultModel
      : metadata.defaultModel;
    const dim = provider === "openai-compat"
      ? (typeof activeConfig.options?.["dim"] === "number" ? activeConfig.options["dim"] as number : 0)
      : (metadata.dimByModel[model] ?? Object.values(metadata.dimByModel)[0] ?? 0);
    return {
      provider,
      requiredEnv: metadata.requiredEnv,
      defaultModel: metadata.defaultModel,
      active: activeConfig.provider === provider,
      model,
      dim,
      keyAvailable: hasProviderCredential(provider, env),
    };
  });
}

export function getEmbedderExpectedDim(config: EmbedderConfig): number {
  const metadata = PROVIDERS[config.provider];
  const model = config.model ?? metadata.defaultModel;
  return metadata.dimByModel[model] ?? Object.values(metadata.dimByModel)[0]!;
}

export function estimateEmbeddingCostUsd(
  provider: EmbedderProvider,
  tokenEstimate: number,
): number {
  const perMillionTokens: Record<EmbedderProvider, number> = {
    lexical: 0,
    voyage: 0.12,
    openai: 0.02,
    ollama: 0,
    "openai-compat": 0,
  };
  return (tokenEstimate / 1_000_000) * perMillionTokens[provider];
}

function hasProviderCredential(
  provider: EmbedderProvider,
  env: NodeJS.ProcessEnv,
): boolean {
  if (provider === "lexical" || provider === "ollama" || provider === "openai-compat") return true;
  return Boolean(env[PROVIDERS[provider].requiredEnv]?.trim());
}

function readProvider(value: unknown): EmbedderProvider | null {
  return value === "lexical" || value === "voyage" || value === "openai" || value === "ollama" || value === "openai-compat"
    ? value
    : null;
}

function createLexicalEmbedder(): Embedder {
  return {
    providerName: "lexical",
    modelName: "lexical",
    dim: 0,
    async embed() {
      return { vectors: [], model: "lexical", dim: 0 };
    },
  };
}

/**
 * Defense-in-depth (SSRF): even though the dashboard config-patch validator
 * already screens outbound URLs, reject a non-http(s) scheme at construction
 * so a hand-edited config.yaml cannot make the embedder fetch a file:// or
 * other-scheme target. OpenAI baseURL carries OPENAI_API_KEY credentials, so
 * it is restricted to the official HTTPS endpoint. Explicit Ollama hosts keep
 * the separate configured-host SSRF policy, and env/default Ollama hosts are
 * operator-controlled to keep local Ollama usable.
 */
function assertHttpUrl(value: string, label: string): string {
  rejectInvalidOutboundHttpUrl(value, label);
  return normalizeOutboundHttpUrl(value) ?? value;
}

function assertConfiguredOutboundUrl(
  value: string,
  label: string,
  allowInternalHosts: boolean,
): string {
  rejectInvalidOutboundHttpUrl(value, label);
  const verdict = allowInternalHosts
    ? classifyOutboundUrl(value)
    : classifyConfiguredOutboundUrl(value);
  if (verdict === "invalid-scheme") {
    throw new EmbedderConfigError(`${label} must be an http(s) URL`);
  }
  if (verdict === "internal" && !allowInternalHosts) {
    throw new EmbedderConfigError(`${label} must not target an internal host unless embedder.allow_internal_hosts is true`);
  }
  if (verdict === "dns-hostname") {
    throw new EmbedderConfigError(
      `${label} DNS hostnames are blocked unless embedder.allow_internal_hosts is true; use an explicit public IP literal or an official provider endpoint`,
    );
  }
  return normalizeOutboundHttpUrl(value) ?? value;
}

function rejectInvalidOutboundHttpUrl(value: string, label: string): void {
  const reason = getOutboundHttpUrlRejectionReason(value);
  if (reason === "invalid-scheme") {
    throw new EmbedderConfigError(`${label} must be an http(s) URL`);
  }
  if (reason === "userinfo") {
    throw new EmbedderConfigError(`${label} must not include URL credentials`);
  }
  if (reason === "query-or-fragment") {
    throw new EmbedderConfigError(`${label} must not include query strings or fragments`);
  }
}

function assertOfficialOpenAIBaseUrl(value: string, label: string): void {
  const verdict = classifyOpenAIBaseUrl(value);
  if (verdict === "invalid-scheme") {
    throw new EmbedderConfigError(`${label} must be an http(s) URL`);
  }
  if (verdict === "not-official") {
    throw new EmbedderConfigError(`${label} must use the official OpenAI HTTPS endpoint`);
  }
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
