import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicAppend } from "../storage/atomic-write.js";
import { withFileLock } from "../storage/file-lock.js";
import { compileRuntimeDir } from "./state.js";
import type { CompileOperation } from "./execute.js";

export function opsJournalPath(vaultRoot: string): string {
  return join(compileRuntimeDir(vaultRoot), "ops-journal.jsonl");
}

export function operationKey(operation: CompileOperation): string {
  return createHash("sha256").update(stableStringify(operation)).digest("hex");
}

export async function readAppliedOperationKeys(vaultRoot: string): Promise<Set<string>> {
  const path = opsJournalPath(vaultRoot);
  if (!existsSync(path)) return new Set();
  const keys = new Set<string>();
  for (const line of (await readFile(path, "utf-8")).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { key?: unknown };
      if (typeof parsed.key === "string" && parsed.key.length > 0) keys.add(parsed.key);
    } catch {
      // Torn append from a crash — skip
    }
  }
  return keys;
}

export async function recordAppliedOperation(
  vaultRoot: string,
  operation: CompileOperation,
): Promise<void> {
  await atomicAppend(
    opsJournalPath(vaultRoot),
    `${JSON.stringify({ key: operationKey(operation), kind: operation.kind, at: new Date().toISOString() })}\n`,
  );
}

export async function clearOpsJournal(vaultRoot: string): Promise<void> {
  await withFileLock(opsJournalPath(vaultRoot), async () => {
    await rm(opsJournalPath(vaultRoot), { force: true });
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
