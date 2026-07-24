import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  ForgetPlan,
  NormalizedForgetSelectors,
} from "../cli/commands/forget.js";
import { readIndexGeneration } from "../index/generation.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { readForgetRecovery } from "./recovery.js";

const execFileAsync = promisify(execFile);

export const LIVE_ERASE_RECEIPT_SCHEMA_VERSION = 1;

export interface RepositoryIdentity {
  readonly head: string;
  readonly fingerprint: string;
  readonly rootFingerprint: string;
  readonly commonGitDirFingerprint: string;
}

export interface LiveEraseReceipt {
  readonly schemaVersion: 1;
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

export interface PersistLiveEraseReceiptOptions {
  readonly root: string;
  readonly selectors: NormalizedForgetSelectors;
  readonly plan: ForgetPlan;
  readonly erased: readonly string[];
  readonly rewritten: readonly string[];
  readonly now?: Date;
}

export interface PersistedLiveEraseReceipt {
  readonly path: string;
  readonly evidenceId: string;
  readonly operationId: string;
  readonly completedAt: string;
  readonly selectionDigest: string;
}

export async function persistSuccessfulLiveEraseReceipt(
  opts: PersistLiveEraseReceiptOptions,
): Promise<PersistedLiveEraseReceipt> {
  const completedAt = (opts.now ?? new Date()).toISOString();
  const generation = readIndexGeneration(opts.root);
  if (generation.state !== "ready") {
    throw new Error("memory forget: live erase completed but receipt was refused because the index is not ready");
  }
  if (await readForgetRecovery(opts.root)) {
    throw new Error("memory forget: live erase completed but receipt was refused because recovery is still pending");
  }
  for (const relPath of opts.erased) {
    if (existsSync(join(opts.root, ...relPath.split("/")))) {
      throw new Error("memory forget: live erase completed but receipt was refused because a removed path is still present");
    }
  }
  for (const relPath of opts.rewritten) {
    if (!existsSync(join(opts.root, ...relPath.split("/")))) {
      throw new Error("memory forget: live erase completed but receipt was refused because a rewritten fact path is missing");
    }
  }

  const targets: LiveEraseReceipt["selection"]["targets"] = {
    raw: [...opts.plan.raw],
    facts: [...opts.plan.facts],
    rewrittenFacts: [...opts.plan.rewrittenFacts],
    generated: [...opts.plan.generated],
    retainedArchives: [...opts.plan.archive],
  };
  const selectionDigest = forgetSelectionDigest(opts.selectors, targets);
  const evidenceId = randomUUID();
  const operationId = randomUUID();
  const root = await realpath(opts.root);
  const receipt: LiveEraseReceipt = {
    schemaVersion: LIVE_ERASE_RECEIPT_SCHEMA_VERSION,
    kind: "memory-fort-live-erase",
    evidenceId,
    operationId,
    completedAt,
    status: "live-erased/history-retained",
    selection: {
      digest: selectionDigest,
      selectors: cloneSelectors(opts.selectors),
      targets,
    },
    repository: await readRepositoryIdentity(root),
    canonicalRootFingerprint: pathFingerprint(root),
    postconditions: {
      indexState: "ready",
      indexGenerationToken: generation.token,
      recovery: "none",
      removedPathsAbsent: true,
      rewrittenPathsCompleted: true,
      gitHistory: "retained",
      backups: "retained",
    },
  };
  const stamp = completedAt.replace(/[:.]/gu, "-");
  const path = join(root, "var", "forget-receipts", `live-erase-${stamp}-${operationId}.json`);
  await atomicWrite(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    path,
    evidenceId,
    operationId,
    completedAt,
    selectionDigest,
  };
}

export async function readLiveEraseReceipt(path: string): Promise<LiveEraseReceipt> {
  const resolved = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory forget --purge-history: live erase receipt is missing or invalid: ${detail}`);
  }
  if (!isLiveEraseReceipt(value)) {
    throw new Error("memory forget --purge-history: live erase receipt is not a completed successful receipt");
  }
  const expectedDigest = forgetSelectionDigest(value.selection.selectors, value.selection.targets);
  if (value.selection.digest !== expectedDigest) {
    throw new Error("memory forget --purge-history: live erase receipt selection digest is invalid");
  }
  return value;
}

export function canonicalRootFromLiveReceiptPath(path: string): string {
  const resolved = resolve(path);
  const receiptDir = dirname(resolved);
  if (dirname(receiptDir) !== join(dirname(dirname(receiptDir)), "var")) {
    throw new Error("memory forget --purge-history: live erase receipt is not in the canonical var/forget-receipts directory");
  }
  return dirname(dirname(receiptDir));
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
    return {
      head,
      fingerprint: repositoryFingerprint(head),
      rootFingerprint: pathFingerprint(canonicalRoot),
      commonGitDirFingerprint: pathFingerprint(commonGitDir),
    };
  } catch {
    return null;
  }
}

export function repositoryFingerprint(head: string): string {
  return `sha256:${sha256Text(`memory-fort-repository-v1\n${head}\n`)}`;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    || !isTargets(selection["targets"])) {
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
  return value["repository"] === null || isRepositoryIdentity(value["repository"]);
}

function isRepositoryIdentity(value: unknown): value is RepositoryIdentity {
  return isRecord(value)
    && typeof value["head"] === "string"
    && /^[0-9a-f]{40,64}$/u.test(value["head"])
    && typeof value["fingerprint"] === "string"
    && typeof value["rootFingerprint"] === "string"
    && typeof value["commonGitDirFingerprint"] === "string";
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
