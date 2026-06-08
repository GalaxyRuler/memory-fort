import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { memoryRoot } from "./paths.js";

export const SECRET_KEYS = ["VOYAGE_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export interface SecretMeta {
  present: boolean;
  last4?: string;
}

/** True when filePath resolves to or under the git-backed vault root. */
function isInsideVault(filePath: string): boolean {
  const rel = relative(resolve(memoryRoot()), resolve(filePath));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readRaw(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Presence + last 4 chars per known key. NEVER returns full secret values. */
export async function readSecretsMeta(filePath: string): Promise<Record<string, SecretMeta>> {
  const raw = readRaw(filePath);
  const meta: Record<string, SecretMeta> = {};
  for (const key of SECRET_KEYS) {
    const val = typeof raw[key] === "string" ? raw[key].trim() : "";
    meta[key] = val ? { present: true, last4: val.slice(-4) } : { present: false };
  }
  return meta;
}

/** Persist one secret. Refuses to write inside the vault. chmod 0600 where supported. */
export async function writeSecret(key: string, value: string, filePath: string): Promise<void> {
  if (isInsideVault(filePath)) {
    throw new Error(`refusing to write secrets inside the vault: ${filePath}`);
  }
  const next = { ...readRaw(filePath), [key]: value };
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** Layer secrets-file values UNDER process.env (real env vars always win). */
export function loadSecretsIntoEnv(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    // best-effort directory creation; reading below is what matters
  }
  const raw = readRaw(filePath);
  for (const key of SECRET_KEYS) {
    const val = typeof raw[key] === "string" ? raw[key].trim() : "";
    if (val && (process.env[key] === undefined || process.env[key] === "")) {
      process.env[key] = val;
    }
  }
}
