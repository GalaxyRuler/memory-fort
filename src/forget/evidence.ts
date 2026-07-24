import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

import type { NormalizedForgetSelectors } from "../cli/commands/forget.js";
import {
  isContentFingerprintEvidence,
  type ContentFingerprintEvidence,
} from "./content-fingerprints.js";
import {
  stableJson,
  verifyEvidenceSignature,
  type EvidenceAuth,
} from "./evidence-auth.js";

const execFileAsync = promisify(execFile);

export const LIVE_ERASE_RECEIPT_SCHEMA_VERSION = 2;

export interface RepositoryRefEvidence {
  readonly heads: Record<string, string>;
  readonly digest: string;
}

export interface RepositoryIdentity {
  readonly head: string;
  readonly fingerprint: string;
  readonly refs: RepositoryRefEvidence;
  readonly rootFingerprint: string;
  readonly commonGitDirFingerprint: string;
}

export interface LiveEraseReceiptPayload {
  readonly schemaVersion: 2;
  readonly kind: "memory-fort-live-erase";
  readonly evidenceId: string;
  readonly operationId: string;
  readonly completedAt: string;
  readonly status: "live-erased/history-retained";
  readonly selection: {
    readonly digest: string;
    readonly selectors: NormalizedForgetSelectors;
    readonly targets: {
      readonly raw: readonly string[];
      readonly facts: readonly string[];
      readonly rewrittenFacts: readonly string[];
      readonly generated: readonly string[];
      readonly retainedArchives: readonly string[];
    };
    readonly contentFingerprints: ContentFingerprintEvidence;
  };
  readonly repository: RepositoryIdentity | null;
  readonly canonicalRootFingerprint: string;
  readonly postconditions: {
    readonly indexState: "ready";
    readonly indexGenerationToken: string;
    readonly recovery: "none";
    readonly removedPathsAbsent: true;
    readonly rewrittenPathsCompleted: true;
    readonly gitHistory: "retained";
    readonly backups: "retained";
  };
}


export type LiveEraseReceipt = LiveEraseReceiptPayload & {
  readonly auth: EvidenceAuth;
};
export interface PersistedLiveEraseReceipt {
  readonly path: string;
  readonly evidenceId: string;
  readonly operationId: string;
  readonly completedAt: string;
  readonly selectionDigest: string;
}

export async function readLiveEraseReceipt(
  path: string,
  evidenceSecurityDir?: string,
): Promise<LiveEraseReceipt> {
  const resolved = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory forget --purge-history: live erase receipt is missing or invalid: ${detail}`);
  }
  await verifyEvidenceSignature(value, evidenceSecurityDir, "live erase receipt");
  if (!isLiveEraseReceipt(value)) {
    throw new Error("memory forget --purge-history: live erase receipt is not a completed successful receipt");
  }
  const expectedDigest = forgetSelectionDigest(value.selection.selectors, value.selection.targets);
  if (value.selection.digest !== expectedDigest) {
    throw new Error("memory forget --purge-history: live erase receipt selection digest is invalid");
  }
  return value;
}


export function forgetSelectionDigest(
  selectors: NormalizedForgetSelectors,
  targets: LiveEraseReceipt["selection"]["targets"],
): string {
  return sha256Text(stableJson({
    selectors: cloneSelectors(selectors),
    targets: {
      raw: [...targets.raw],
      facts: [...targets.facts],
      rewrittenFacts: [...targets.rewrittenFacts],
      generated: [...targets.generated],
      retainedArchives: [...targets.retainedArchives],
    },
  }));
}

export async function readRepositoryIdentity(root: string): Promise<RepositoryIdentity | null> {
  try {
    const canonicalRoot = await realpath(root);
    const head = await gitOutput(canonicalRoot, ["rev-parse", "HEAD"]);
    const commonGitDirRaw = await gitOutput(canonicalRoot, ["rev-parse", "--git-common-dir"]);
    const commonGitDir = await realpath(
      isAbsolute(commonGitDirRaw) ? commonGitDirRaw : resolve(canonicalRoot, commonGitDirRaw),
    );
    const refs = await readRepositoryRefEvidence(canonicalRoot);
    return {
      head,
      fingerprint: repositoryFingerprint(head, refs),
      refs,
      rootFingerprint: pathFingerprint(canonicalRoot),
      commonGitDirFingerprint: pathFingerprint(commonGitDir),
    };
  } catch {
    return null;
  }
}

export async function readRepositoryRefEvidence(root: string): Promise<RepositoryRefEvidence> {
  const output = await gitOutput(root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
  ]);
  const entries = output
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(refs\/heads\/\S+) ([0-9a-f]{40,64})$/u.exec(line);
      if (!match) throw new Error("memory forget: local branch evidence is invalid");
      return [match[1]!, match[2]!] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  const heads: Record<string, string> = {};
  for (const [name, objectId] of entries) heads[name] = objectId;
  return { heads, digest: repositoryRefsDigest(heads) };
}

export function repositoryRefsDigest(heads: Record<string, string>): string {
  return `sha256:${sha256Text(`memory-fort-local-heads-v1\n${stableJson(heads)}\n`)}`;
}

export function repositoryFingerprint(head: string, refs: RepositoryRefEvidence): string {
  return `sha256:${sha256Text(
    `memory-fort-repository-v2\n${head}\n${refs.digest}\n${stableJson(refs.heads)}\n`,
  )}`;
}

export function pathFingerprint(path: string): string {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return `sha256:${sha256Text(`memory-fort-path-v1\n${normalized}\n`)}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneSelectors(selectors: NormalizedForgetSelectors): NormalizedForgetSelectors {
  return {
    paths: [...selectors.paths],
    rawPaths: [...selectors.rawPaths],
    sourceIds: [...selectors.sourceIds],
  };
}


function isLiveEraseReceipt(value: unknown): value is LiveEraseReceipt {
  if (!isRecord(value)) return false;
  if (value["schemaVersion"] !== LIVE_ERASE_RECEIPT_SCHEMA_VERSION
    || value["kind"] !== "memory-fort-live-erase"
    || value["status"] !== "live-erased/history-retained"
    || !isIsoDate(value["completedAt"])
    || typeof value["evidenceId"] !== "string"
    || typeof value["operationId"] !== "string"
    || typeof value["canonicalRootFingerprint"] !== "string") {
    return false;
  }
  const selection = value["selection"];
  const postconditions = value["postconditions"];
  if (!isRecord(selection)
    || typeof selection["digest"] !== "string"
    || !isSelectors(selection["selectors"])
    || !isTargets(selection["targets"])
    || !isContentFingerprintEvidence(selection["contentFingerprints"])) {
    return false;
  }
  if (!isRecord(postconditions)
    || postconditions["indexState"] !== "ready"
    || typeof postconditions["indexGenerationToken"] !== "string"
    || postconditions["recovery"] !== "none"
    || postconditions["removedPathsAbsent"] !== true
    || postconditions["rewrittenPathsCompleted"] !== true
    || postconditions["gitHistory"] !== "retained"
    || postconditions["backups"] !== "retained") {
    return false;
  }
  return isEvidenceAuth(value["auth"])
    && (value["repository"] === null || isRepositoryIdentity(value["repository"]));
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  if (!isRecord(value)
    || typeof value["head"] !== "string"
    || !/^[0-9a-f]{40,64}$/u.test(value["head"])
    || typeof value["fingerprint"] !== "string"
    || !isRepositoryRefEvidence(value["refs"])
    || typeof value["rootFingerprint"] !== "string"
    || typeof value["commonGitDirFingerprint"] !== "string") {
    return false;
  }
  return value["fingerprint"] === repositoryFingerprint(value["head"], value["refs"]);
}

export function isRepositoryRefEvidence(value: unknown): value is RepositoryRefEvidence {
  if (!isRecord(value) || !isRecord(value["heads"]) || typeof value["digest"] !== "string") {
    return false;
  }
  const heads = value["heads"];
  const names = Object.keys(heads);
  return names.every((name) => /^refs\/heads\/\S+$/u.test(name)
      && typeof heads[name] === "string"
      && /^[0-9a-f]{40,64}$/u.test(heads[name]))
    && names.every((name, index) => index === 0 || names[index - 1]!.localeCompare(name) < 0)
    && value["digest"] === repositoryRefsDigest(heads as Record<string, string>);
}

function isEvidenceAuth(value: unknown): value is EvidenceAuth {
  return isRecord(value)
    && value["algorithm"] === "HMAC-SHA256"
    && typeof value["keyId"] === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(value["keyId"])
    && typeof value["signature"] === "string"
    && /^[0-9a-f]{64}$/u.test(value["signature"]);
}

function isSelectors(value: unknown): value is NormalizedForgetSelectors {
  return isRecord(value)
    && isStringArray(value["paths"])
    && isStringArray(value["rawPaths"])
    && isStringArray(value["sourceIds"]);
}

function isTargets(value: unknown): value is LiveEraseReceipt["selection"]["targets"] {
  return isRecord(value)
    && isStringArray(value["raw"])
    && isStringArray(value["facts"])
    && isStringArray(value["rewrittenFacts"])
    && isStringArray(value["generated"])
    && isStringArray(value["retainedArchives"]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}
