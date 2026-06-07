import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite as defaultAtomicWrite } from "../storage/atomic-write.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";
import { classifyConfiguredOutboundUrl, classifyOpenAIBaseUrl, classifyOutboundUrl } from "../storage/url-safety.js";

export interface ConfigPatchValidationError {
  path: string;
  message: string;
}

export interface ConfigPatchValidation {
  ok: boolean;
  errors: ConfigPatchValidationError[];
}

export interface ConfigPatchResult {
  applied: string[];
}

export interface ApplyConfigPatchOptions {
  atomicWrite?: (absolutePath: string, content: string) => Promise<void>;
  now?: () => Date;
  /** @deprecated Use allowInternalHosts.embedder. */
  allowInternalEmbedderHosts?: boolean;
  allowInternalHosts?: InternalHostAllowances;
}

export interface ValidateConfigPatchOptions {
  /** @deprecated Use allowInternalHosts.embedder. */
  allowInternalEmbedderHosts?: boolean;
  /** Permit internal/loopback/metadata outbound hosts per config section. */
  allowInternalHosts?: InternalHostAllowances;
  /** Existing provider context used for partial section patches. */
  sectionProviders?: SectionProviders;
}

export interface InternalHostAllowances {
  embedder?: boolean;
  llm?: boolean;
}

export interface SectionProviders {
  embedder?: string;
  llm?: string;
}

export class ConfigPatchError extends Error {
  constructor(
    message: string,
    public readonly errors: ConfigPatchValidationError[],
  ) {
    super(message);
    this.name = "ConfigPatchError";
  }
}

const SAFELISTED_PATHS = new Set([
  "embedder.provider",
  "embedder.model",
  "embedder.options",
  "embedder.allow_internal_hosts",
  "llm.provider",
  "llm.model",
  "llm.max_tokens",
  "llm.temperature",
  "llm.options",
  "llm.allow_internal_hosts",
  "auto_promote.enabled",
  "auto_promote.cadence",
  "auto_promote.confidence_threshold",
  "auto_heal.enabled",
  "auto_heal.daily_budget_usd",
  "auto_heal.max_docs_per_tick",
  "auto_heal.max_tokens_per_tick",
  "auto_heal.tick_interval_seconds",
  "auto_heal.capture_debounce_seconds",
  "compile.scheduled",
  "compile.cadence",
  "compile.execute",
  "capture.max_input_bytes",
  "capture.max_output_bytes",
  "dashboard.trusted_origins",
  "dashboard.behind_proxy",
]);

// Keys inside embedder.options / llm.options whose value is an outbound URL.
const URL_LIKE_OPTION_KEY = /^(base[_-]?url|url|host|endpoint)$/i;

const VALID_TOP_LEVEL_KEYS = new Set(["embedder", "llm", "auto_promote", "auto_heal", "compile", "capture", "dashboard"]);
const VALID_EMBEDDER_PROVIDERS = new Set(["lexical", "voyage", "openai", "ollama"]);
const VALID_LLM_PROVIDERS = new Set(["openrouter", "ollama"]);
const VALID_AUTO_PROMOTE_CADENCES = new Set(["weekly", "daily", "manual"]);
const VALID_AUTO_PROMOTE_THRESHOLDS = new Set(["high", "none"]);
const VALID_COMPILE_CADENCES = new Set(["daily", "weekly", "manual"]);

export function validateConfigPatch(
  body: unknown,
  opts: ValidateConfigPatchOptions = {},
): ConfigPatchValidation {
  const errors: ConfigPatchValidationError[] = [];
  const root = asPlainObject(body);
  if (!root) {
    return { ok: false, errors: [{ path: "", message: "body must be an object" }] };
  }

  // A patch that itself turns on allow_internal_hosts opts in for that section
  // in the same write. The opt-in is deliberately not shared across sections.
  const allowInternal = resolveInternalHostAllowances(root, opts);

  for (const [sectionKey, sectionValue] of Object.entries(root)) {
    if (!VALID_TOP_LEVEL_KEYS.has(sectionKey)) {
      errors.push({ path: sectionKey, message: "top-level field not in safelist" });
      continue;
    }

    const section = asPlainObject(sectionValue);
    if (!section) {
      errors.push({ path: sectionKey, message: "section must be an object" });
      continue;
    }

    for (const [fieldKey, value] of Object.entries(section)) {
      const path = `${sectionKey}.${fieldKey}`;
      if (!SAFELISTED_PATHS.has(path)) {
        errors.push({ path, message: "field not in safelist" });
        continue;
      }
      validateValue(
        path,
        value,
        readSectionProvider(section) ?? readSectionProviderContext(sectionKey, opts.sectionProviders),
        allowInternal,
        errors,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function applyConfigPatch(
  vaultRoot: string,
  patch: Record<string, unknown>,
  opts: ApplyConfigPatchOptions = {},
): Promise<ConfigPatchResult> {
  const configPath = join(vaultRoot, "config.yaml");
  const current = await loadMemoryConfig(vaultRoot);
  const allowInternalHosts = opts.allowInternalHosts ?? allowInternalHostsFromConfig(current);

  const validation = validateConfigPatch(patch, {
    allowInternalEmbedderHosts: opts.allowInternalEmbedderHosts,
    allowInternalHosts,
    sectionProviders: sectionProvidersFromConfig(current),
  });
  if (!validation.ok) {
    throw new ConfigPatchError("invalid config patch", validation.errors);
  }

  const next = mergeAtSafelistedPaths(current, patch);
  const finalValidation = validateMergedOutboundState(next);
  if (!finalValidation.ok) {
    throw new ConfigPatchError("invalid config patch", finalValidation.errors);
  }

  const currentRaw = await readConfigRaw(configPath);
  const applied = listAppliedPaths(patch);
  const atomicWrite = opts.atomicWrite ?? defaultAtomicWrite;

  await writeBackup(vaultRoot, currentRaw, opts);
  try {
    await atomicWrite(configPath, dumpConfig(next));
  } catch (error) {
    throw new Error(
      `failed to write config.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await pruneBackups(vaultRoot, 5);
  return { applied };
}

function validateValue(
  path: string,
  value: unknown,
  sectionProvider: string | undefined,
  allowInternal: InternalHostAllowances,
  errors: ConfigPatchValidationError[],
): void {
  if (path === "embedder.provider" && !VALID_EMBEDDER_PROVIDERS.has(String(value))) {
    errors.push({ path, message: "invalid embedder provider" });
  }
  if (path === "llm.provider" && !VALID_LLM_PROVIDERS.has(String(value))) {
    errors.push({ path, message: "invalid llm provider" });
  }
  if ((path === "embedder.model" || path === "llm.model") && !isNonEmptyString(value)) {
    errors.push({ path, message: "model must be a non-empty string" });
  }
  if (
    path === "llm.max_tokens" &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 32000)
  ) {
    errors.push({ path, message: "max_tokens must be an integer between 1 and 32000" });
  }
  if (path === "llm.temperature" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2)) {
    errors.push({ path, message: "temperature must be a number between 0 and 2" });
  }
  if ((path === "embedder.options" || path === "llm.options") && !asPlainObject(value)) {
    errors.push({ path, message: "options must be a plain object" });
  }
  if (path === "embedder.options" || path === "llm.options") {
    rejectSecretLikeKeys(path, value, errors);
    rejectUnsafeOutboundUrls(
      path,
      value,
      allowInternalForPath(path, allowInternal),
      errors,
      sectionProvider,
    );
  }
  if (
    (path === "embedder.allow_internal_hosts" ||
      path === "llm.allow_internal_hosts" ||
      path === "dashboard.behind_proxy") &&
    typeof value !== "boolean"
  ) {
    errors.push({ path, message: `${path.split(".").pop()} must be a boolean` });
  }
  if (path === "auto_promote.enabled" && typeof value !== "boolean") {
    errors.push({ path, message: "enabled must be a boolean" });
  }
  if (path === "auto_promote.cadence" && !VALID_AUTO_PROMOTE_CADENCES.has(String(value))) {
    errors.push({ path, message: "cadence must be weekly, daily, or manual" });
  }
  if (
    path === "auto_promote.confidence_threshold" &&
    !VALID_AUTO_PROMOTE_THRESHOLDS.has(String(value))
  ) {
    errors.push({ path, message: "confidence_threshold must be high or none" });
  }
  if (path === "auto_heal.enabled" && typeof value !== "boolean") {
    errors.push({ path, message: "enabled must be a boolean" });
  }
  if (path === "auto_heal.daily_budget_usd" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1000)) {
    errors.push({ path, message: "daily_budget_usd must be a non-negative number" });
  }
  if (
    (path === "auto_heal.max_docs_per_tick" ||
      path === "auto_heal.max_tokens_per_tick" ||
      path === "auto_heal.tick_interval_seconds") &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000)
  ) {
    errors.push({ path, message: "auto_heal cap must be a positive integer" });
  }
  if (
    path === "auto_heal.capture_debounce_seconds" &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000)
  ) {
    errors.push({ path, message: "capture_debounce_seconds must be a non-negative integer" });
  }
  if (path === "compile.scheduled" && typeof value !== "boolean") {
    errors.push({ path, message: "scheduled must be a boolean" });
  }
  if (path === "compile.execute" && typeof value !== "boolean") {
    errors.push({ path, message: "execute must be a boolean" });
  }
  if (path === "compile.cadence" && !VALID_COMPILE_CADENCES.has(String(value))) {
    errors.push({ path, message: "cadence must be daily, weekly, or manual" });
  }
  if (
    (path === "capture.max_input_bytes" || path === "capture.max_output_bytes") &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000)
  ) {
    errors.push({ path, message: "capture byte cap must be an integer between 0 and 1000000" });
  }
  if (
    path === "dashboard.trusted_origins" &&
    (!Array.isArray(value) || value.some((origin) => typeof origin !== "string" || origin.trim().length === 0))
  ) {
    errors.push({ path, message: "trusted_origins must be an array of non-empty strings" });
  }
}

/**
 * Block SSRF: any URL-like field (baseURL/host/url/endpoint) inside
 * embedder/llm options must be an http(s) URL, and must not target an
 * internal/loopback/metadata host unless internal hosts are explicitly
 * allowed (e.g. for a local Ollama via embedder.allow_internal_hosts).
 */
function rejectUnsafeOutboundUrls(
  path: string,
  value: unknown,
  allowInternal: boolean,
  errors: ConfigPatchValidationError[],
  sectionProvider?: string,
): void {
  const record = asPlainObject(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (typeof child === "string" && URL_LIKE_OPTION_KEY.test(key)) {
      if (isOpenAIEmbedderBaseUrl(path, key, sectionProvider)) {
        const verdict = classifyOpenAIBaseUrl(child);
        if (verdict === "invalid-scheme") {
          errors.push({ path: childPath, message: "must be an http(s) URL" });
        } else if (verdict === "not-official") {
          errors.push({
            path: childPath,
            message: "must use the official OpenAI HTTPS endpoint",
          });
        }
        continue;
      }

      const verdict = allowInternal
        ? classifyOutboundUrl(child)
        : classifyConfiguredOutboundUrl(child);
      if (verdict === "invalid-scheme") {
        errors.push({ path: childPath, message: "must be an http(s) URL" });
      } else if (verdict === "internal" && !allowInternal) {
        errors.push({
          path: childPath,
          message:
            "internal, loopback, or metadata hosts are blocked (SSRF); set allow_internal_hosts: true to permit local providers such as Ollama",
        });
      } else if (verdict === "dns-hostname") {
        errors.push({
          path: childPath,
          message:
            "DNS hostnames are blocked for configured outbound URLs unless allow_internal_hosts is true; use an explicit public IP literal or an official provider endpoint",
        });
      }
    } else if (asPlainObject(child)) {
      rejectUnsafeOutboundUrls(childPath, child, allowInternal, errors, sectionProvider);
    }
  }
}

function isOpenAIEmbedderBaseUrl(
  path: string,
  key: string,
  sectionProvider: string | undefined,
): boolean {
  return path === "embedder.options" &&
    /^base[_-]?url$/i.test(key) &&
    sectionProvider === "openai";
}

function resolveInternalHostAllowances(
  root: Record<string, unknown>,
  opts: ValidateConfigPatchOptions,
): InternalHostAllowances {
  return {
    embedder: opts.allowInternalHosts?.embedder === true ||
      opts.allowInternalEmbedderHosts === true ||
      sectionPatchEnablesInternalHosts(root, "embedder"),
    llm: opts.allowInternalHosts?.llm === true ||
      sectionPatchEnablesInternalHosts(root, "llm"),
  };
}

function sectionPatchEnablesInternalHosts(
  root: Record<string, unknown>,
  sectionKey: "embedder" | "llm",
): boolean {
  const section = asPlainObject(root[sectionKey]);
  return section?.["allow_internal_hosts"] === true;
}

function allowInternalForPath(path: string, allowInternal: InternalHostAllowances): boolean {
  if (path.startsWith("embedder.")) return allowInternal.embedder === true;
  if (path.startsWith("llm.")) return allowInternal.llm === true;
  return false;
}

/** Read section-scoped boolean flags (e.g. embedder.allow_internal_hosts). */
export function allowInternalHostsFromConfig(config: MemoryConfig): InternalHostAllowances {
  return {
    embedder: asPlainObject(config.embedder)?.["allow_internal_hosts"] === true,
    llm: asPlainObject(config.llm)?.["allow_internal_hosts"] === true,
  };
}

function validateMergedOutboundState(config: MemoryConfig): ConfigPatchValidation {
  const errors: ConfigPatchValidationError[] = [];
  for (const sectionKey of ["embedder", "llm"] as const) {
    const section = asPlainObject(config[sectionKey]);
    if (!section) continue;
    const options = section["options"];
    if (options === undefined) continue;
    rejectUnsafeOutboundUrls(
      `${sectionKey}.options`,
      options,
      section["allow_internal_hosts"] === true,
      errors,
      readSectionProvider(section),
    );
  }
  return { ok: errors.length === 0, errors };
}

function readSectionProvider(section: Record<string, unknown>): string | undefined {
  return typeof section["provider"] === "string" ? section["provider"] : undefined;
}

function readSectionProviderContext(
  sectionKey: string,
  providers: SectionProviders | undefined,
): string | undefined {
  if (sectionKey === "embedder") return providers?.embedder;
  if (sectionKey === "llm") return providers?.llm;
  return undefined;
}

function sectionProvidersFromConfig(config: MemoryConfig): SectionProviders {
  return {
    embedder: readSectionProvider(asPlainObject(config.embedder) ?? {}),
    llm: readSectionProvider(asPlainObject(config.llm) ?? {}),
  };
}

function rejectSecretLikeKeys(
  path: string,
  value: unknown,
  errors: ConfigPatchValidationError[],
): void {
  const record = asPlainObject(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (isSecretLikeKey(key)) {
      errors.push({ path: childPath, message: "API keys and secrets are env-var-only" });
      continue;
    }
    if (asPlainObject(child)) rejectSecretLikeKeys(childPath, child, errors);
  }
}

function isSecretLikeKey(key: string): boolean {
  return /(^|[_-])(api[_-]?key|token|secret|password)($|[_-])/i.test(key) ||
    /^(api[_-]?key|token|secret|password)$/i.test(key);
}

function mergeAtSafelistedPaths(
  current: MemoryConfig,
  patch: Record<string, unknown>,
): MemoryConfig {
  const next: MemoryConfig = clonePlain(current);
  for (const sectionKey of ["embedder", "llm", "auto_promote", "auto_heal", "compile", "capture", "dashboard"] as const) {
    const sectionPatch = asPlainObject(patch[sectionKey]);
    if (!sectionPatch) continue;
    const target = asPlainObject(next[sectionKey]) ?? {};
    next[sectionKey] = { ...target, ...clonePlain(sectionPatch) } as never;
  }
  return next;
}

function listAppliedPaths(patch: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const sectionKey of ["embedder", "llm", "auto_promote", "auto_heal", "compile", "capture", "dashboard"] as const) {
    const sectionPatch = asPlainObject(patch[sectionKey]);
    if (!sectionPatch) continue;
    for (const fieldKey of Object.keys(sectionPatch)) {
      paths.push(`${sectionKey}.${fieldKey}`);
    }
  }
  return paths;
}

async function writeBackup(
  vaultRoot: string,
  currentRaw: string,
  opts: ApplyConfigPatchOptions,
): Promise<void> {
  const backupDir = join(vaultRoot, ".config-backups");
  await mkdir(backupDir, { recursive: true });
  const timestamp = (opts.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:.]/g, "-");
  await defaultAtomicWrite(join(backupDir, `${timestamp}.yaml`), currentRaw);
}

async function pruneBackups(vaultRoot: string, keep: number): Promise<void> {
  const backupDir = join(vaultRoot, ".config-backups");
  const backups = (await readdir(backupDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
  const prunable = backups.slice(0, Math.max(0, backups.length - keep));
  for (const name of prunable) {
    await rm(join(backupDir, name), { force: true });
  }
}

async function readConfigRaw(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function dumpConfig(config: MemoryConfig): string {
  return yaml.dump(config, {
    schema: yaml.JSON_SCHEMA,
    lineWidth: 100,
    noRefs: true,
    sortKeys: false,
  });
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}
