import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicAppend, atomicWrite } from "../storage/atomic-write.js";
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

export interface RecordAppliedOperationOptions {
  /** Raw rel-paths that produced this apply batch (for scoped journal prune). */
  sourceRaws?: readonly string[];
}

export async function recordAppliedOperation(
  vaultRoot: string,
  operation: CompileOperation,
  opts: RecordAppliedOperationOptions = {},
): Promise<void> {
  const sourceRaws = (opts.sourceRaws ?? [])
    .map((raw) => raw.replace(/\\/g, "/"))
    .filter((raw) => raw.length > 0);
  await atomicAppend(
    opsJournalPath(vaultRoot),
    `${JSON.stringify({
      key: operationKey(operation),
      kind: operation.kind,
      at: new Date().toISOString(),
      ...(sourceRaws.length > 0 ? { sourceRaws } : {}),
    })}\n`,
  );
}

export async function clearOpsJournal(vaultRoot: string): Promise<void> {
  await withFileLock(opsJournalPath(vaultRoot), async () => {
    await rm(opsJournalPath(vaultRoot), { force: true });
  });
}

/**
 * Drop journal entries whose source raws have all advanced. Keeps guards for
 * stalled batches (applied + proposed) when an unrelated content raw advances.
 * Untagged legacy lines clear on any content advance (previous global behavior).
 */
export async function pruneOpsJournalForAdvancedRaws(
  vaultRoot: string,
  advancedRelPaths: readonly string[],
): Promise<void> {
  if (advancedRelPaths.length === 0) return;
  const advanced = new Set(
    advancedRelPaths.map((raw) => raw.replace(/\\/g, "/")).filter((raw) => raw.length > 0),
  );
  if (advanced.size === 0) return;

  await withFileLock(opsJournalPath(vaultRoot), async () => {
    const path = opsJournalPath(vaultRoot);
    if (!existsSync(path)) return;
    const kept: string[] = [];
    for (const line of (await readFile(path, "utf-8")).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as { sourceRaws?: unknown };
        const raws = Array.isArray(parsed.sourceRaws)
          ? parsed.sourceRaws
            .filter((raw): raw is string => typeof raw === "string")
            .map((raw) => raw.replace(/\\/g, "/"))
          : [];
        if (raws.length === 0) {
          // Legacy untagged entry: previous behavior cleared on any content advance.
          continue;
        }
        const fullyAdvanced = raws.every((raw) => advanced.has(raw));
        if (!fullyAdvanced) kept.push(line);
      } catch {
        kept.push(line);
      }
    }
    if (kept.length === 0) {
      await rm(path, { force: true });
      return;
    }
    await atomicWrite(path, `${kept.join("\n")}\n`);
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
