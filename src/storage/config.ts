import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { memoryRoot as defaultMemoryRoot } from "./paths.js";

export interface ResolvedCompileConfig {
  scheduled: boolean;
  cadence: "daily" | "weekly" | "manual";
  execute: boolean;
  raw_filter: boolean;
  raw_filter_min_signal_bytes: number;
  drain: boolean;
  max_passes_per_run: number;
  condensed_index: boolean;
  index_desc_chars: number;
  index_max_bytes: number;
  similarity_context: {
    enabled: boolean;
    threshold: number;
  };
}

export interface MemoryConfig {
  llm?: {
    provider?: string;
    model?: string;
    max_tokens?: number;
    temperature?: number;
    options?: Record<string, unknown>;
    allow_internal_hosts?: boolean;
  };
  embedder?: {
    provider?: string;
    model?: string;
    options?: Record<string, unknown>;
    allow_internal_hosts?: boolean;
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
  sync?: {
    remote_name?: string;
  };
  search?: {
    hyde?: boolean;
  };
  graph?: {
    edge_weights?: Record<string, number>;
  };
  auto_link?: {
    enabled?: boolean;
    similarity_threshold?: number;
    title_threshold?: number;
    mass_collision_threshold?: number;
    exempt_hub_pages?: string[];
  };
  auto_heal?: {
    enabled?: boolean;
    daily_budget_usd?: number;
    max_docs_per_tick?: number;
    max_tokens_per_tick?: number;
    tick_interval_seconds?: number;
    capture_debounce_seconds?: number;
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
    raw_filter?: boolean;
    raw_filter_min_signal_bytes?: number;
    drain?: boolean;
    max_passes_per_run?: number;
    condensed_index?: boolean;
    index_desc_chars?: number;
    index_max_bytes?: number;
    similarity_context?: {
      enabled?: boolean;
      threshold?: number;
    };
  };
  capture?: {
    max_input_bytes?: number;
    max_output_bytes?: number;
    tools?: Record<string, string>;
    exclude_patterns?: string[];
  };
  compress?: {
    max_input_bytes?: number;
    chunk_threshold_bytes?: number;
    max_chunks?: number;
    max_call_tokens?: number;
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
    url?: string;
    trusted_origins?: string[];
    /** Honor X-Forwarded-* headers in the same-origin gate (reverse-proxy deployments). */
    behind_proxy?: boolean;
  };
  clients?: Record<string, boolean>;
  chatgpt?: {
    bridge_port?: number;
  };
  retrieval?: {
    embeddings?: {
      contextualized?: boolean;
      context_version?: number;
    };
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
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a YAML object`);
  }
  return parsed as MemoryConfig;
}

export function resolveCompileConfig(raw: MemoryConfig["compile"]): ResolvedCompileConfig {
  const config = raw ?? {};
  return {
    scheduled: config.scheduled === true,
    cadence: config.cadence === "weekly" || config.cadence === "manual" ? config.cadence : "daily",
    execute: config.execute === true,
    raw_filter: config.raw_filter === true,
    raw_filter_min_signal_bytes: readInteger(config.raw_filter_min_signal_bytes, 40),
    drain: config.drain === true,
    max_passes_per_run: readInteger(config.max_passes_per_run, 25),
    condensed_index: config.condensed_index !== false,
    index_desc_chars: readIntegerInRange(config.index_desc_chars, 0, 1_000, 50),
    index_max_bytes: readIntegerInRange(config.index_max_bytes, 1_000, 1_000_000, 32_000),
    similarity_context: {
      enabled: config.similarity_context?.enabled === true,
      threshold: typeof config.similarity_context?.threshold === "number"
        && Number.isFinite(config.similarity_context.threshold)
        ? config.similarity_context.threshold
        : 0.7,
    },
  };
}

export function validateMemoryConfig(config: MemoryConfig): string[] {
  const warnings: string[] = [];
  const embedder = asRecord(config.embedder);
  if (embedder?.["provider"] !== undefined && !["lexical", "voyage", "openai", "ollama"].includes(String(embedder["provider"]))) {
    warnings.push(`embedder.provider has invalid value ${JSON.stringify(embedder["provider"])}`);
  }
  const embedding = asRecord(config.embedding);
  if (embedding?.["provider"] !== undefined && !["lexical", "voyage", "openai", "ollama"].includes(String(embedding["provider"]))) {
    warnings.push(`embedding.provider has invalid value ${JSON.stringify(embedding["provider"])}`);
  }
  const llm = asRecord(config.llm);
  if (llm?.["provider"] !== undefined && !["openrouter", "ollama", "openai-compat"].includes(String(llm["provider"]))) {
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
  if (compile?.["raw_filter"] !== undefined && typeof compile["raw_filter"] !== "boolean") {
    warnings.push("compile.raw_filter must be a boolean");
  }
  if (
    compile?.["raw_filter_min_signal_bytes"] !== undefined &&
    !isIntegerInRange(compile["raw_filter_min_signal_bytes"], 0, 1_000_000)
  ) {
    warnings.push("compile.raw_filter_min_signal_bytes must be an integer between 0 and 1000000");
  }
  if (compile?.["drain"] !== undefined && typeof compile["drain"] !== "boolean") {
    warnings.push("compile.drain must be a boolean");
  }
  if (compile?.["max_passes_per_run"] !== undefined && !isIntegerInRange(compile["max_passes_per_run"], 1, 1_000)) {
    warnings.push("compile.max_passes_per_run must be an integer between 1 and 1000");
  }
  if (compile?.["condensed_index"] !== undefined && typeof compile["condensed_index"] !== "boolean") {
    warnings.push("compile.condensed_index must be a boolean");
  }
  if (compile?.["index_desc_chars"] !== undefined && !isIntegerInRange(compile["index_desc_chars"], 0, 1_000)) {
    warnings.push("compile.index_desc_chars must be an integer between 0 and 1000");
  }
  if (compile?.["index_max_bytes"] !== undefined && !isIntegerInRange(compile["index_max_bytes"], 1_000, 1_000_000)) {
    warnings.push("compile.index_max_bytes must be an integer between 1000 and 1000000");
  }
  const graph = asRecord(config.graph);
  const edgeWeights = asRecord(graph?.["edge_weights"]);
  if (graph?.["edge_weights"] !== undefined && !edgeWeights) {
    warnings.push("graph.edge_weights must be an object mapping edge type to non-negative number");
  }
  for (const [key, value] of Object.entries(edgeWeights ?? {})) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      warnings.push(`graph.edge_weights.${key} must be a non-negative number`);
    }
  }
  const autoLink = asRecord(config.auto_link);
  if (autoLink?.["enabled"] !== undefined && typeof autoLink["enabled"] !== "boolean") {
    warnings.push("auto_link.enabled must be a boolean");
  }
  if (autoLink?.["similarity_threshold"] !== undefined && !isNumberInRange(autoLink["similarity_threshold"], 0, 1)) {
    warnings.push("auto_link.similarity_threshold must be a number between 0 and 1");
  }
  if (autoLink?.["title_threshold"] !== undefined && !isNumberInRange(autoLink["title_threshold"], 0, 1)) {
    warnings.push("auto_link.title_threshold must be a number between 0 and 1");
  }
  if (autoLink?.["mass_collision_threshold"] !== undefined && !isNumberInRange(autoLink["mass_collision_threshold"], 0, 1)) {
    warnings.push("auto_link.mass_collision_threshold must be a number between 0 and 1");
  }
  if (
    autoLink?.["exempt_hub_pages"] !== undefined &&
    (
      !Array.isArray(autoLink["exempt_hub_pages"]) ||
      !autoLink["exempt_hub_pages"].every((item) => typeof item === "string" && item.trim().length > 0)
    )
  ) {
    warnings.push("auto_link.exempt_hub_pages must be a list of non-empty wiki path strings");
  }
  const autoHeal = asRecord(config.auto_heal);
  if (autoHeal?.["enabled"] !== undefined && typeof autoHeal["enabled"] !== "boolean") {
    warnings.push("auto_heal.enabled must be a boolean");
  }
  if (autoHeal?.["daily_budget_usd"] !== undefined && !isNumberInRange(autoHeal["daily_budget_usd"], 0, 1000)) {
    warnings.push("auto_heal.daily_budget_usd must be a non-negative number");
  }
  for (const key of ["max_docs_per_tick", "max_tokens_per_tick", "tick_interval_seconds"]) {
    if (autoHeal?.[key] !== undefined && !isIntegerInRange(autoHeal[key], 1, 1_000_000)) {
      warnings.push(`auto_heal.${key} must be a positive integer`);
    }
  }
  if (
    autoHeal?.["capture_debounce_seconds"] !== undefined &&
    !isIntegerInRange(autoHeal["capture_debounce_seconds"], 0, 1_000_000)
  ) {
    warnings.push("auto_heal.capture_debounce_seconds must be a non-negative integer");
  }
  const capture = asRecord(config.capture);
  for (const key of ["max_input_bytes", "max_output_bytes"]) {
    if (capture?.[key] !== undefined && !isIntegerInRange(capture[key], 0, 1_000_000)) {
      warnings.push(`capture.${key} must be an integer between 0 and 1000000`);
    }
  }
  const compress = asRecord(config.compress);
  for (const key of ["max_input_bytes", "chunk_threshold_bytes"]) {
    if (compress?.[key] !== undefined && !isIntegerInRange(compress[key], 1_000, 1_000_000)) {
      warnings.push(`compress.${key} must be an integer between 1000 and 1000000`);
    }
  }
  if (compress?.["max_chunks"] !== undefined && !isIntegerInRange(compress["max_chunks"], 2, 100)) {
    warnings.push("compress.max_chunks must be an integer between 2 and 100");
  }
  if (compress?.["max_call_tokens"] !== undefined && !isIntegerInRange(compress["max_call_tokens"], 1_000, 128_000)) {
    warnings.push("compress.max_call_tokens must be an integer between 1000 and 128000");
  }
  const retention = asRecord(config.retention);
  for (const key of ["raw_window_days", "wiki_status_stale_days"]) {
    if (retention?.[key] !== undefined && !isIntegerInRange(retention[key], 1, 3650)) {
      warnings.push(`retention.${key} must be an integer between 1 and 3650`);
    }
  }
  const clients = asRecord(config.clients);
  if (config.clients !== undefined && !clients) {
    warnings.push("clients must be an object mapping client id to a boolean");
  }
  for (const [id, value] of Object.entries(clients ?? {})) {
    if (typeof value !== "boolean") {
      warnings.push(`clients.${id} must be a boolean`);
    }
  }
  if (config.chatgpt !== undefined) {
    const port = config.chatgpt.bridge_port;
    if (port !== undefined && !isIntegerInRange(port, 1024, 65535)) {
      warnings.push("chatgpt.bridge_port must be an integer between 1024 and 65535");
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

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function readIntegerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return isIntegerInRange(value, min, max) ? value as number : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Returns the configured bridge port, defaulting to 3100. */
export function getChatGptBridgePort(config: MemoryConfig): number {
  const port = config.chatgpt?.bridge_port;
  if (port === undefined) return 3100;
  return port;
}

/** A client is enabled unless config.clients[id] is explicitly false. */
export function isClientEnabled(config: MemoryConfig, id: string): boolean {
  return config.clients?.[id] !== false;
}
