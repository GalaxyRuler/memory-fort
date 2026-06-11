import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../storage/atomic-write.js";

/**
 * Ledger of human-resolved compile proposals. Once an operation has been
 * approved or rejected from the inbox, re-staging the byte-identical
 * operation is suppressed — without this, a long-running drain regenerates
 * the same proposal right after the user resolves it. Operations with any
 * content difference hash differently and stage normally.
 */

export interface ResolvedProposalEntry {
  action: "approved" | "rejected";
  resolvedAt: string;
  path?: string;
}

interface LedgerFile {
  resolved?: Record<string, ResolvedProposalEntry>;
}

export function resolvedProposalsPath(vaultRoot: string): string {
  return join(vaultRoot, "var", "compile", "resolved-proposals.json");
}

export function hashCompileOperationForLedger(operation: unknown): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 32);
}

export async function readResolvedProposals(vaultRoot: string): Promise<Record<string, ResolvedProposalEntry>> {
  const path = resolvedProposalsPath(vaultRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as LedgerFile;
    return parsed.resolved && typeof parsed.resolved === "object" ? parsed.resolved : {};
  } catch {
    return {};
  }
}

export async function isProposalResolved(vaultRoot: string, operation: unknown): Promise<boolean> {
  const resolved = await readResolvedProposals(vaultRoot);
  return hashCompileOperationForLedger(operation) in resolved;
}

export async function recordProposalResolved(
  vaultRoot: string,
  operation: unknown,
  action: ResolvedProposalEntry["action"],
  opts: { now?: Date; path?: string } = {},
): Promise<void> {
  const resolved = await readResolvedProposals(vaultRoot);
  resolved[hashCompileOperationForLedger(operation)] = {
    action,
    resolvedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.path ? { path: opts.path } : {}),
  };
  await atomicWrite(
    resolvedProposalsPath(vaultRoot),
    `${JSON.stringify({ resolved }, null, 2)}\n`,
  );
}
