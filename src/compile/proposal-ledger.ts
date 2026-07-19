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
  /**
   * Date-stable identity (volatile frontmatter stripped). Lets restages with
   * new created/updated match ledger entries recorded under older hash schemes.
   */
  stableKey?: string;
}

interface LedgerFile {
  resolved?: Record<string, ResolvedProposalEntry>;
}

export function resolvedProposalsPath(vaultRoot: string): string {
  return join(vaultRoot, "var", "compile", "resolved-proposals.json");
}

/**
 * Frontmatter fields rewritten by normalizeFrontmatter/groundOperation on every
 * stage (dates, etc.). Including them in the ledger key makes a human-resolved
 * proposal look "fresh" after a day boundary even when body/path are identical.
 */
const VOLATILE_FRONTMATTER_KEYS = new Set([
  "created",
  "updated",
]);

/**
 * Normalize operations to the same shape `readOperation` / dashboard
 * promote-reject produce, so ledger keys match across stage vs resolve.
 * (rewrite_page/write_page without frontmatter become frontmatter: {};
 * compile-managed volatile fields are omitted from the key.)
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
    const frontmatter = typeof record.frontmatter === "object"
      && record.frontmatter !== null
      && !Array.isArray(record.frontmatter)
      ? stripVolatileFrontmatter(record.frontmatter as Record<string, unknown>)
      : {};
    return {
      kind: record.kind,
      path: record.path,
      body: record.body,
      frontmatter,
    };
  }
  return operation;
}

function stripVolatileFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (VOLATILE_FRONTMATTER_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function rawHashCompileOperationForLedger(operation: unknown): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex").slice(0, 32);
}

export function hashCompileOperationForLedger(operation: unknown): string {
  return rawHashCompileOperationForLedger(canonicalizeCompileOperationForLedger(operation));
}

/**
 * Keys that may identify this operation in a ledger file, including pre-upgrade
 * hashes (raw JSON, empty frontmatter, full frontmatter with created/updated).
 */
export function ledgerLookupKeysForOperation(operation: unknown): string[] {
  const keys = new Set<string>();
  keys.add(hashCompileOperationForLedger(operation));
  keys.add(rawHashCompileOperationForLedger(operation));
  for (const variant of legacyWriteRewriteShapes(operation)) {
    keys.add(rawHashCompileOperationForLedger(variant));
  }
  return [...keys];
}

function legacyWriteRewriteShapes(operation: unknown): unknown[] {
  if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
    return [];
  }
  const record = operation as Record<string, unknown>;
  if (
    (record.kind !== "rewrite_page" && record.kind !== "write_page")
    || typeof record.path !== "string"
    || typeof record.body !== "string"
  ) {
    return [];
  }
  const variants: unknown[] = [
    // Pre-frontmatter-normalization: no frontmatter property
    { kind: record.kind, path: record.path, body: record.body },
    // After frontmatter:{} default, before volatile strip
    { kind: record.kind, path: record.path, body: record.body, frontmatter: {} },
  ];
  const fm = typeof record.frontmatter === "object"
    && record.frontmatter !== null
    && !Array.isArray(record.frontmatter)
    ? record.frontmatter as Record<string, unknown>
    : null;
  if (fm) {
    // Full frontmatter including created/updated (common groundOperation shape)
    variants.push({
      kind: record.kind,
      path: record.path,
      body: record.body,
      frontmatter: { ...fm },
    });
    // Same with volatile fields removed (intermediate / current canonical body)
    variants.push({
      kind: record.kind,
      path: record.path,
      body: record.body,
      frontmatter: stripVolatileFrontmatter(fm),
    });
  }
  return variants;
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
  const canonicalKey = hashCompileOperationForLedger(operation);
  const lookupKeys = new Set(ledgerLookupKeysForOperation(operation));

  let matchedEntry: ResolvedProposalEntry | undefined;
  let matchedKey: string | undefined;
  for (const [key, entry] of Object.entries(resolved)) {
    if (lookupKeys.has(key) || entry.stableKey === canonicalKey) {
      matchedEntry = entry;
      matchedKey = key;
      break;
    }
  }
  if (!matchedEntry || matchedKey === undefined) return false;

  // Migrate legacy map keys / missing stableKey onto the canonical form.
  if (matchedKey !== canonicalKey || matchedEntry.stableKey !== canonicalKey) {
    for (const key of lookupKeys) {
      if (key !== canonicalKey) delete resolved[key];
    }
    if (matchedKey !== canonicalKey) delete resolved[matchedKey];
    resolved[canonicalKey] = {
      ...matchedEntry,
      stableKey: canonicalKey,
    };
    await atomicWrite(
      resolvedProposalsPath(vaultRoot),
      `${JSON.stringify({ resolved }, null, 2)}\n`,
    );
  }
  return true;
}

export async function recordProposalResolved(
  vaultRoot: string,
  operation: unknown,
  action: ResolvedProposalEntry["action"],
  opts: { now?: Date; path?: string } = {},
): Promise<void> {
  const resolved = await readResolvedProposals(vaultRoot);
  const canonicalKey = hashCompileOperationForLedger(operation);
  const entry: ResolvedProposalEntry = {
    action,
    resolvedAt: (opts.now ?? new Date()).toISOString(),
    stableKey: canonicalKey,
    ...(opts.path ? { path: opts.path } : {}),
  };
  // Drop legacy alias keys so the ledger migrates toward the canonical hash.
  for (const key of ledgerLookupKeysForOperation(operation)) {
    if (key !== canonicalKey) delete resolved[key];
  }
  // Also drop any prior entry that only carried this stableKey under another map key.
  for (const [key, existing] of Object.entries(resolved)) {
    if (key !== canonicalKey && existing.stableKey === canonicalKey) delete resolved[key];
  }
  resolved[canonicalKey] = entry;
  await atomicWrite(
    resolvedProposalsPath(vaultRoot),
    `${JSON.stringify({ resolved }, null, 2)}\n`,
  );
}
