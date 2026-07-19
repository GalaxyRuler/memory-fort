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

/**
 * Normalize operations to the same shape `readOperation` / dashboard
 * promote-reject produce, so ledger keys match across stage vs resolve.
 * (rewrite_page/write_page without frontmatter become frontmatter: {}.)
 */
export function canonicalizeCompileOperationForLedger(operation: unknown): unknown {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    return operation;
  }
  const record = operation as Record<string, unknown>;
  if (
    (record.kind === "rewrite_page" || record.kind === "write_page")
    && typeof record.path === "string"
    && typeof record.body === "string"
  ) {
    return {
      kind: record.kind,
      path: record.path,
      body: record.body,
      frontmatter: typeof record.frontmatter === "object"
        && record.frontmatter !== null
        && !Array.isArray(record.frontmatter)
        ? record.frontmatter
        : {},
    };
  }
  return operation;
}

function rawHashCompileOperationForLedger(operation: unknown): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 32);
}

export function hashCompileOperationForLedger(operation: unknown): string {
  return rawHashCompileOperationForLedger(canonicalizeCompileOperationForLedger(operation));
}

/**
 * Keys that may identify this operation in a ledger file, including pre-upgrade
 * hashes that used raw JSON.stringify without frontmatter normalization.
 */
export function ledgerLookupKeysForOperation(operation: unknown): string[] {
  const keys = new Set<string>();
  keys.add(hashCompileOperationForLedger(operation));
  keys.add(rawHashCompileOperationForLedger(operation));
  // Pre-canonical ledgers stored rewrite/write without frontmatter: {}.
  const stripped = stripEmptyFrontmatterForLegacyLookup(operation);
  if (stripped !== undefined) {
    keys.add(rawHashCompileOperationForLedger(stripped));
  }
  return [...keys];
}

function stripEmptyFrontmatterForLegacyLookup(operation: unknown): unknown | undefined {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    return undefined;
  }
  const record = operation as Record<string, unknown>;
  if (
    (record.kind !== "rewrite_page" && record.kind !== "write_page")
    || typeof record.path !== "string"
    || typeof record.body !== "string"
  ) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(record, "frontmatter")) return undefined;
  const fm = record.frontmatter;
  const empty = typeof fm === "object" && fm !== null && !Array.isArray(fm)
    && Object.keys(fm as object).length === 0;
  if (!empty) return undefined;
  return { kind: record.kind, path: record.path, body: record.body };
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
  return ledgerLookupKeysForOperation(operation).some((key) => key in resolved);
}

export async function recordProposalResolved(
  vaultRoot: string,
  operation: unknown,
  action: ResolvedProposalEntry["action"],
  opts: { now?: Date; path?: string } = {},
): Promise<void> {
  const resolved = await readResolvedProposals(vaultRoot);
  const entry: ResolvedProposalEntry = {
    action,
    resolvedAt: (opts.now ?? new Date()).toISOString(),
    ...(opts.path ? { path: opts.path } : {}),
  };
  const canonicalKey = hashCompileOperationForLedger(operation);
  // Drop legacy alias keys so the ledger migrates toward the canonical hash.
  for (const key of ledgerLookupKeysForOperation(operation)) {
    if (key !== canonicalKey) delete resolved[key];
  }
  resolved[canonicalKey] = entry;
  await atomicWrite(
    resolvedProposalsPath(vaultRoot),
    `${JSON.stringify({ resolved }, null, 2)}\n`,
  );
}
