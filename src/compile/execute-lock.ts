import { join } from "node:path";

import { withFileLock } from "../storage/file-lock.js";

const COMPILE_EXECUTE_LOCK_OPTIONS = { timeoutMs: 60_000, staleMs: 300_000 } as const;

export function compileExecuteLockTarget(vaultRoot: string): string {
  return join(vaultRoot, "var", "compile", "execute");
}

export function withCompileExecuteLock<T>(
  vaultRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withFileLock(
    compileExecuteLockTarget(vaultRoot),
    operation,
    COMPILE_EXECUTE_LOCK_OPTIONS,
  );
}
