import { join, resolve } from "node:path";

import { withFileLock } from "../storage/file-lock.js";

const COMPILE_EXECUTE_LOCK_OPTIONS = { timeoutMs: 60_000, staleMs: 300_000 } as const;
const COMPILE_EXECUTE_LOCK_OWNERSHIP = Symbol("compile-execute-lock-ownership");
const activeOwnerships = new WeakSet<object>();

export interface CompileExecuteLockOwnership {
  readonly vaultRoot: string;
  readonly [COMPILE_EXECUTE_LOCK_OWNERSHIP]: true;
}

export function compileExecuteLockTarget(vaultRoot: string): string {
  return join(vaultRoot, "var", "compile", "execute");
}

export function withCompileExecuteLock<T>(
  vaultRoot: string,
  operation: (ownership: CompileExecuteLockOwnership) => Promise<T>,
): Promise<T> {
  const normalizedRoot = normalizeVaultRoot(vaultRoot);
  return withFileLock(
    compileExecuteLockTarget(normalizedRoot),
    async () => {
      const ownership: CompileExecuteLockOwnership = Object.freeze({
        vaultRoot: normalizedRoot,
        [COMPILE_EXECUTE_LOCK_OWNERSHIP]: true as const,
      });
      activeOwnerships.add(ownership);
      try {
        return await operation(ownership);
      } finally {
        activeOwnerships.delete(ownership);
      }
    },
    COMPILE_EXECUTE_LOCK_OPTIONS,
  );
}

export function assertCompileExecuteLockOwnership(
  ownership: CompileExecuteLockOwnership,
  vaultRoot: string,
): void {
  if (!activeOwnerships.has(ownership)) {
    throw new Error("compile publication requires an active compile execute lock ownership");
  }
  if (ownership.vaultRoot !== normalizeVaultRoot(vaultRoot)) {
    throw new Error("compile execute lock ownership does not match the publication vault root");
  }
}

function normalizeVaultRoot(vaultRoot: string): string {
  const normalized = resolve(vaultRoot);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
