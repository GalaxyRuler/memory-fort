import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type ProvenanceResolutionReason =
  | "verified"
  | "invalid-receipt"
  | "source-unavailable"
  | "source-hash-mismatch"
  | "range-out-of-bounds"
  | "chunk-hash-mismatch";

export interface ProvenanceResolution {
  readonly valid: boolean;
  readonly reason: ProvenanceResolutionReason;
  readonly text: string | null;
  readonly byteStart: number | null;
  readonly byteEnd: number | null;
}

interface ReceiptRange {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly sourceContentHash: string;
  readonly chunkTextHash: string;
}

export async function resolveProvenanceReceipt(
  vaultRoot: string,
  value: unknown,
): Promise<ProvenanceResolution> {
  const receipt = parseReceipt(value);
  if (!receipt) return invalid("invalid-receipt");
  const absolutePath = resolve(vaultRoot, ...receipt.path.split("/"));
  const relativePath = relative(resolve(vaultRoot), absolutePath);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..\\`) || relativePath.startsWith("../")) {
    return invalid("invalid-receipt");
  }

  let source: Buffer;
  try {
    source = await readFile(absolutePath);
  } catch {
    return invalid("source-unavailable");
  }
  if (sha256(source) !== receipt.sourceContentHash) {
    return invalid("source-hash-mismatch");
  }
  if (receipt.byteStart < 0 || receipt.byteEnd <= receipt.byteStart || receipt.byteEnd > source.length) {
    return invalid("range-out-of-bounds");
  }
  const exactBytes = source.subarray(receipt.byteStart, receipt.byteEnd);
  if (sha256(exactBytes) !== receipt.chunkTextHash) {
    return invalid("chunk-hash-mismatch");
  }
  return {
    valid: true,
    reason: "verified",
    text: exactBytes.toString("utf8"),
    byteStart: receipt.byteStart,
    byteEnd: receipt.byteEnd,
  };
}

function parseReceipt(value: unknown): ReceiptRange | null {
  if (!isRecord(value)) return null;
  const path = value["path"];
  const byteStart = value["byteStart"];
  const byteEnd = value["byteEnd"];
  const sourceContentHash = value["sourceContentHash"];
  const chunkTextHash = value["chunkTextHash"];
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    !Number.isSafeInteger(byteStart) ||
    !Number.isSafeInteger(byteEnd) ||
    typeof sourceContentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceContentHash) ||
    typeof chunkTextHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(chunkTextHash)
  ) return null;
  return { path, byteStart: byteStart as number, byteEnd: byteEnd as number, sourceContentHash, chunkTextHash };
}

function invalid(reason: Exclude<ProvenanceResolutionReason, "verified">): ProvenanceResolution {
  return { valid: false, reason, text: null, byteStart: null, byteEnd: null };
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
