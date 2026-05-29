import { readFile } from "node:fs/promises";
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
  try {
    return parseMemoryConfigYaml(await readFile(join(root, "config.yaml"), "utf-8"));
  } catch (error) {
    if (isMissingFile(error)) return {};
    console.warn(
      `Warning: failed to parse config.yaml: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {};
  }
}

function parseMemoryConfigYaml(text: string): MemoryConfig {
  const parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as MemoryConfig;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
