import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { memoryRoot as defaultMemoryRoot } from "./paths.js";

export interface MemoryConfig {
  llm?: {
    provider?: string;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    options?: Record<string, unknown>;
  };
  embedder?: {
    provider?: string;
    model?: string;
    options?: Record<string, unknown>;
  };
  embedding?: {
    provider?: string;
    model?: string;
    dim?: number;
  };
  // Provider secrets are env-var-only; config.yaml must not define API key fields.
  voyage?: Record<string, unknown>;
  vps?: {
    host?: string;
    install_root?: string;
    ssh_user?: string;
  };
  search?: {
    hyde?: boolean;
  };
  auto_promote?: {
    enabled?: boolean;
    cadence?: "weekly" | "daily" | "manual";
    confidence_threshold?: "high" | "none";
  };
  compile?: {
    scheduled?: boolean;
    cadence?: "daily" | "weekly" | "manual";
    execute?: boolean;
  };
  retention?: {
    raw_window_days?: number;
    raw_compile_before_delete?: boolean;
    embeddings_prune_with_raw?: boolean;
    wiki_status_stale_days?: number;
    crystals_never_auto_delete?: boolean;
    archive_before_delete?: boolean;
  };
  dashboard?: {
    trusted_origins?: string[];
  };
  [key: string]: unknown;
}

export async function loadMemoryConfig(
  memoryRoot?: string,
): Promise<MemoryConfig> {
  const root = memoryRoot ?? defaultMemoryRoot();
  const path = join(root, "config.yaml");
  try {
    const config = parseMemoryConfigYaml(await readFile(path, "utf-8"), path);
    for (const warning of validateMemoryConfig(config)) {
      await logConfigIssue(root, `Warning: config.yaml: ${warning}`);
    }
    return config;
  } catch (error) {
    if (isMissingFile(error)) return {};
    await logConfigIssue(
      root,
      `Warning: failed to parse config.yaml as YAML at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

export function parseMemoryConfigYaml(text: string, path = "config.yaml"): MemoryConfig {
  const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a YAML object`);
  }
  return parsed as MemoryConfig;
}

export function validateMemoryConfig(config: MemoryConfig): string[] {
  const warnings: string[] = [];
  const embedder = asRecord(config.embedder);
  if (embedder?.["provider"] !== undefined && !["voyage", "openai", "ollama"].includes(String(embedder["provider"]))) {
    warnings.push(`embedder.provider has invalid value ${JSON.stringify(embedder["provider"])}`);
  }
  const embedding = asRecord(config.embedding);
  if (embedding?.["provider"] !== undefined && !["voyage", "openai", "ollama"].includes(String(embedding["provider"]))) {
    warnings.push(`embedding.provider has invalid value ${JSON.stringify(embedding["provider"])}`);
  }
  const llm = asRecord(config.llm);
  if (llm?.["provider"] !== undefined && !["openrouter", "ollama"].includes(String(llm["provider"]))) {
    warnings.push(`llm.provider has invalid value ${JSON.stringify(llm["provider"])}`);
  }
  if (llm?.["max_tokens"] !== undefined && !isIntegerInRange(llm["max_tokens"], 1, 32_000)) {
    warnings.push("llm.max_tokens must be an integer between 1 and 32000");
  }
  if (llm?.["temperature"] !== undefined && !isNumberInRange(llm["temperature"], 0, 2)) {
    warnings.push("llm.temperature must be a number between 0 and 2");
  }
  const autoPromote = asRecord(config.auto_promote);
  if (autoPromote?.["cadence"] !== undefined && !["weekly", "daily", "manual"].includes(String(autoPromote["cadence"]))) {
    warnings.push("auto_promote.cadence must be weekly, daily, or manual");
  }
  const compile = asRecord(config.compile);
  if (compile?.["cadence"] !== undefined && !["weekly", "daily", "manual"].includes(String(compile["cadence"]))) {
    warnings.push("compile.cadence must be weekly, daily, or manual");
  }
  const retention = asRecord(config.retention);
  for (const key of ["raw_window_days", "wiki_status_stale_days"]) {
    if (retention?.[key] !== undefined && !isIntegerInRange(retention[key], 1, 3650)) {
      warnings.push(`retention.${key} must be an integer between 1 and 3650`);
    }
  }
  return warnings;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function logConfigIssue(root: string, message: string): Promise<void> {
  console.warn(message);
  try {
    await appendFile(join(root, "errors.log"), `[${new Date().toISOString()}] ${message}\n`, "utf-8");
  } catch {
    // Config diagnostics should be visible on stderr even if the vault is not writable yet.
  }
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
