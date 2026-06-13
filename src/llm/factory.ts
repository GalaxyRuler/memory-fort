import type { MemoryConfig } from "../storage/config.js";
import {
  classifyConfiguredOutboundUrl,
  classifyOutboundUrl,
  getOutboundHttpUrlRejectionReason,
  normalizeOutboundHttpUrl,
} from "../storage/url-safety.js";
import { createOllamaLLM } from "./ollama.js";
import { createOpenAICompatLLM } from "./openai-compat.js";
import { createOpenRouterLLM } from "./openrouter.js";
import { LLMConfigError, LLMDisabledError, type LLMProvider } from "./types.js";
import { withLLMTimeout } from "./with-timeout.js";

export { LLMConfigError, LLMDisabledError } from "./types.js";

export type LLMProviderName = "openrouter" | "ollama" | "openai-compat";

export interface LLMConfig {
  provider: LLMProviderName;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  timeout_ms?: number;
  options?: Record<string, unknown>;
  allowInternalHosts?: boolean;
}

export interface LLMProviderInfo {
  provider: LLMProviderName;
  requiredEnv: "OPENROUTER_API_KEY" | "OLLAMA_HOST" | "none";
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
  "openai-compat": {
    requiredEnv: "none",
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
  const result: LLMConfig = {
    provider,
    model: readString(raw["model"]) ?? PROVIDERS[provider].defaultModel,
    max_tokens: readNumber(raw["max_tokens"]),
    temperature: readNumber(raw["temperature"]),
  };
  const timeoutMs = readNumber(raw["timeout_ms"]);
  if (timeoutMs !== undefined) result.timeout_ms = timeoutMs;
  const options = asRecord(raw["options"]);
  if (options) result.options = options;
  if (raw["allow_internal_hosts"] === true) result.allowInternalHosts = true;
  return result;
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

  return withLLMTimeout(createBaseProvider(config, env), config.timeout_ms);
}

function createBaseProvider(
  config: LLMConfig,
  env: NodeJS.ProcessEnv,
): LLMProvider {
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
    case "ollama": {
      const configuredHost = readString(config.options?.["host"]);
      const envHost = readString(env["OLLAMA_HOST"]);
      const host = configuredHost
        ? assertConfiguredOutboundUrl(configuredHost, "OLLAMA host", config.allowInternalHosts === true)
        : envHost
          ? assertHttpUrl(envHost, "OLLAMA host")
          : undefined;
      return createOllamaLLM({
        host,
        model: config.model,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
      });
    }
    case "openai-compat": {
      const baseURL = readString(config.options?.["baseURL"]);
      if (!baseURL) throw new LLMConfigError("openai-compat llm requires options.baseURL");
      const validatedURL = assertConfiguredOutboundUrl(baseURL, "openai-compat baseURL", config.allowInternalHosts === true);
      const apiKey = readString(config.options?.["apiKey"]);
      return createOpenAICompatLLM({
        baseURL: validatedURL,
        model: config.model,
        apiKey,
        maxTokens: config.max_tokens,
        temperature: config.temperature,
      });
    }
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
  return (["openrouter", "ollama", "openai-compat"] as const).map((provider) => {
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
  if (provider === "ollama" || provider === "openai-compat") return true;
  return Boolean(env[PROVIDERS[provider].requiredEnv]?.trim());
}

function readProvider(value: unknown): LLMProviderName | null {
  return value === "openrouter" || value === "ollama" || value === "openai-compat" ? value : null;
}

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
    throw new LLMConfigError(`${label} must be an http(s) URL`);
  }
  if (verdict === "internal" && !allowInternalHosts) {
    throw new LLMConfigError(`${label} must not target an internal host unless llm.allow_internal_hosts is true`);
  }
  if (verdict === "dns-hostname") {
    throw new LLMConfigError(
      `${label} DNS hostnames are blocked unless llm.allow_internal_hosts is true; use an explicit public IP literal or an official provider endpoint`,
    );
  }
  return normalizeOutboundHttpUrl(value) ?? value;
}

function rejectInvalidOutboundHttpUrl(value: string, label: string): void {
  const reason = getOutboundHttpUrlRejectionReason(value);
  if (reason === "invalid-scheme") {
    throw new LLMConfigError(`${label} must be an http(s) URL`);
  }
  if (reason === "userinfo") {
    throw new LLMConfigError(`${label} must not include URL credentials`);
  }
  if (reason === "query-or-fragment") {
    throw new LLMConfigError(`${label} must not include query strings or fragments`);
  }
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
