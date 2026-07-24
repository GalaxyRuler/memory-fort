import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { RawCaptureEpochTransition } from "../hooks/raw-file.js";
import { atomicWrite } from "../storage/atomic-write.js";

export const FORGET_APPLY_LOCK = {
  timeoutMs: 30_000,
  staleMs: 60_000,
  pollMs: 100,
} as const;

export interface ForgetRecoveryRecord {
  version: 1;
  indexInvalidatingToken: string;
  epochs: RawCaptureEpochTransition[];
}

export function forgetApplyLockTarget(vaultRoot: string): string {
  return join(vaultRoot, "var", "forget-apply");
}

export function forgetRecoveryPath(vaultRoot: string): string {
  return join(vaultRoot, "var", "forget-recovery.json");
}

export async function readForgetRecovery(
  vaultRoot: string,
): Promise<ForgetRecoveryRecord | null> {
  let content: string;
  try {
    content = await readFile(forgetRecoveryPath(vaultRoot), "utf-8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("memory reindex: forget recovery metadata is corrupt");
  }
  if (!isForgetRecoveryRecord(parsed, vaultRoot)) {
    throw new Error("memory reindex: forget recovery metadata is corrupt");
  }
  return parsed;
}

export async function writeForgetRecovery(
  vaultRoot: string,
  input: {
    indexInvalidatingToken: string;
    epochs: readonly RawCaptureEpochTransition[];
  },
): Promise<ForgetRecoveryRecord> {
  const record: ForgetRecoveryRecord = {
    version: 1,
    indexInvalidatingToken: input.indexInvalidatingToken,
    epochs: [...input.epochs]
      .map((epoch) => ({ ...epoch, rawPath: resolve(epoch.rawPath) }))
      .sort((a, b) => a.rawPath.localeCompare(b.rawPath)),
  };
  if (!isForgetRecoveryRecord(record, vaultRoot)) {
    throw new Error("memory forget: refused invalid recovery metadata");
  }
  await atomicWrite(forgetRecoveryPath(vaultRoot), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export async function clearForgetRecovery(
  vaultRoot: string,
  expectedIndexToken: string,
): Promise<void> {
  const current = await readForgetRecovery(vaultRoot);
  if (!current) return;
  if (current.indexInvalidatingToken !== expectedIndexToken) {
    throw new Error(
      `memory reindex: forget recovery ownership changed; expected ${expectedIndexToken}, found ${current.indexInvalidatingToken}`,
    );
  }
  await rm(forgetRecoveryPath(vaultRoot), { force: true });
}

function isForgetRecoveryRecord(value: unknown, vaultRoot: string): value is ForgetRecoveryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || !isToken(record.indexInvalidatingToken)
    || !Array.isArray(record.epochs)
  ) return false;

  const seen = new Set<string>();
  for (const value of record.epochs) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const epoch = value as Record<string, unknown>;
    if (
      typeof epoch.rawPath !== "string"
      || !isRawPathForVault(epoch.rawPath, vaultRoot)
      || !isToken(epoch.previousToken)
      || !isToken(epoch.invalidatingToken)
      || !isToken(epoch.readyToken)
    ) return false;
    const key = normalizePath(epoch.rawPath);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isRawPathForVault(rawPath: string, vaultRoot: string): boolean {
  if (!isAbsolute(rawPath)) return false;
  const rawRoot = resolve(vaultRoot, "raw");
  const rel = relative(rawRoot, resolve(rawPath));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9-]+$/u.test(value);
}

function normalizePath(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}
