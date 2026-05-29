import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { atomicWrite as defaultAtomicWrite } from "../storage/atomic-write.js";
import { loadMemoryConfig, type MemoryConfig } from "../storage/config.js";

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
  "llm.provider",
  "llm.model",
  "llm.max_tokens",
  "llm.temperature",
  "llm.options",
  "auto_promote.enabled",
  "auto_promote.cadence",
  "auto_promote.confidence_threshold",
  "compile.scheduled",
  "compile.cadence",
  "compile.execute",
  "dashboard.trusted_origins",
]);

const VALID_TOP_LEVEL_KEYS = new Set(["embedder", "llm", "auto_promote", "compile", "dashboard"]);
const VALID_EMBEDDER_PROVIDERS = new Set(["voyage", "openai", "ollama"]);
const VALID_LLM_PROVIDERS = new Set(["openrouter", "ollama"]);
const VALID_AUTO_PROMOTE_CADENCES = new Set(["weekly", "daily", "manual"]);
const VALID_AUTO_PROMOTE_THRESHOLDS = new Set(["high", "none"]);
const VALID_COMPILE_CADENCES = new Set(["daily", "weekly", "manual"]);

export function validateConfigPatch(body: unknown): ConfigPatchValidation {
  const errors: ConfigPatchValidationError[] = [];
  const root = asPlainObject(body);
  if (!root) {
    return { ok: false, errors: [{ path: "", message: "body must be an object" }] };
  }

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
      validateValue(path, value, errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function applyConfigPatch(
  vaultRoot: string,
  patch: Record<string, unknown>,
  opts: ApplyConfigPatchOptions = {},
): Promise<ConfigPatchResult> {
  const validation = validateConfigPatch(patch);
  if (!validation.ok) {
    throw new ConfigPatchError("invalid config patch", validation.errors);
  }

  const configPath = join(vaultRoot, "config.yaml");
  const currentRaw = await readConfigRaw(configPath);
  const current = await loadMemoryConfig(vaultRoot);
  const applied = listAppliedPaths(patch);
  const next = mergeAtSafelistedPaths(current, patch);
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
    path === "dashboard.trusted_origins" &&
    (!Array.isArray(value) || value.some((origin) => typeof origin !== "string" || origin.trim().length === 0))
  ) {
    errors.push({ path, message: "trusted_origins must be an array of non-empty strings" });
  }
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
  for (const sectionKey of ["embedder", "llm", "auto_promote", "compile", "dashboard"] as const) {
    const sectionPatch = asPlainObject(patch[sectionKey]);
    if (!sectionPatch) continue;
    const target = asPlainObject(next[sectionKey]) ?? {};
    next[sectionKey] = { ...target, ...clonePlain(sectionPatch) } as never;
  }
  return next;
}

function listAppliedPaths(patch: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const sectionKey of ["embedder", "llm", "auto_promote", "compile", "dashboard"] as const) {
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
