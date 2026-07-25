import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import type {
  ForgetPlan,
  NormalizedForgetSelectors,
} from "../cli/commands/forget.js";
import { readIndexGeneration } from "../index/generation.js";
import {
  collectSelectedContentFingerprints,
  type ContentFingerprintEvidence,
} from "./content-fingerprints.js";
import {
  forgetSelectionDigest,
  pathFingerprint,
  readLiveEraseReceipt,
  readRepositoryIdentity,
  sha256Text,
  type LiveEraseReceipt,
  type LiveEraseReceiptPayload,
  type PersistedLiveEraseReceipt,
  type RepositoryIdentity,
} from "./evidence.js";
import {
  createEvidenceSigner,
  stableJson,
  type EvidenceAuth,
  type EvidenceSigner,
  type EvidenceSignerFactory,
} from "./evidence-auth.js";
import {
  assertExternalEvidencePath,
  evidenceOperationDir,
  persistVerifiedSignedEvidence,
  readVerifiedEvidenceFile,
  resolveEvidenceRecordsRoot,
  type EvidenceWrite,
} from "./evidence-store.js";
import { readForgetRecovery } from "./recovery.js";

export interface LiveErasePreparedPayload {
  readonly schemaVersion: 1;
  readonly kind: "memory-fort-live-erase-prepared";
  readonly evidenceId: string;
  readonly operationId: string;
  readonly preparedAt: string;
  readonly status: "prepared";
  readonly operationDigest: string;
  readonly evidenceKeyId: string;
  readonly selection: LiveEraseReceiptPayload["selection"];
  readonly plan: ForgetPlan;
  readonly repository: RepositoryIdentity;
  readonly canonicalRootFingerprint: string;
  readonly intendedPostconditions: {
    readonly indexState: "ready";
    readonly recovery: "none";
    readonly removedPathsAbsent: true;
    readonly rewrittenPathsCompleted: true;
    readonly gitHistory: "retained";
    readonly backups: "retained";
  };
  readonly recovery: {
    readonly action: "rerun-same-selector-forget-apply";
    readonly command: string;
  };
}

export type LiveErasePreparedJournal = LiveErasePreparedPayload & {
  readonly auth: EvidenceAuth;
};

export interface PrepareLiveEraseEvidenceOptions {
  readonly root: string;
  readonly selectors: NormalizedForgetSelectors;
  readonly plan: ForgetPlan;
  readonly contentFingerprints: ContentFingerprintEvidence;
  readonly now?: Date;
  readonly evidenceSecurityDir?: string;
  readonly signerFactory?: EvidenceSignerFactory;
  readonly write?: EvidenceWrite;
}

export interface PreparedLiveEraseEvidence {
  readonly journalPath: string;
  readonly receiptPath: string;
  readonly journal: LiveErasePreparedJournal;
  readonly signer: EvidenceSigner;
  readonly evidenceSecurityDir?: string;
  readonly write?: EvidenceWrite;
}

export interface ResumedLiveEraseEvidence {
  readonly state: "completed";
  readonly plan: ForgetPlan;
  readonly erased: string[];
  readonly rewritten: string[];
  readonly receipt: PersistedLiveEraseReceipt;
}

export interface RestartPreparedLiveEraseEvidence {
  readonly state: "restart-prepared";
  readonly prepared: PreparedLiveEraseEvidence;
}

export type LiveEraseResume = ResumedLiveEraseEvidence | RestartPreparedLiveEraseEvidence;

export class LiveEraseEvidencePendingError extends Error {
  readonly journalPath: string;
  readonly recoveryAction: string;

  constructor(journalPath: string, recoveryAction: string, detail: string) {
    super(
      `memory forget: live erase evidence is pending after mutation; verified prepared journal: ${journalPath}; ${recoveryAction}; ${detail}`,
    );
    this.name = "LiveEraseEvidencePendingError";
    this.journalPath = journalPath;
    this.recoveryAction = recoveryAction;
  }
}

export async function prepareLiveEraseEvidence(
  opts: PrepareLiveEraseEvidenceOptions,
): Promise<PreparedLiveEraseEvidence | null> {
  const root = await realpath(opts.root);
  const repository = await readRepositoryIdentity(root);
  if (!repository) return null;

  const targets = targetsFromPlan(opts.plan);
  const selectionDigest = forgetSelectionDigest(opts.selectors, targets);
  const operationDigest = liveEraseOperationDigest(root, selectionDigest);
  const operationDir = evidenceOperationDir(
    "live-erase",
    sha256Text(stableJson({ operationDigest, attemptId: randomUUID() })),
    opts.evidenceSecurityDir,
  );
  const journalPath = join(operationDir, "prepared.json");
  const receiptPath = join(operationDir, "receipt.json");
  assertExternalEvidencePath(root, journalPath, "live erase prepared journal");
  assertExternalEvidencePath(root, receiptPath, "live erase receipt");
  const signer = await (opts.signerFactory ?? createEvidenceSigner)(opts.evidenceSecurityDir);
  const payload: LiveErasePreparedPayload = {
    schemaVersion: 1,
    kind: "memory-fort-live-erase-prepared",
    evidenceId: randomUUID(),
    operationId: randomUUID(),
    preparedAt: (opts.now ?? new Date()).toISOString(),
    status: "prepared",
    operationDigest,
    evidenceKeyId: signer.keyId,
    selection: {
      digest: selectionDigest,
      selectors: cloneSelectors(opts.selectors),
      targets,
      contentFingerprints: opts.contentFingerprints,
    },
    plan: clonePlan(opts.plan),
    repository,
    canonicalRootFingerprint: pathFingerprint(root),
    intendedPostconditions: {
      indexState: "ready",
      recovery: "none",
      removedPathsAbsent: true,
      rewrittenPathsCompleted: true,
      gitHistory: "retained",
      backups: "retained",
    },
    recovery: {
      action: "rerun-same-selector-forget-apply",
      command: formatRetryCommand(opts.selectors),
    },
  };
  const journal = await persistVerifiedSignedEvidence(
    journalPath,
    payload,
    signer,
    opts.evidenceSecurityDir,
    "live erase prepared journal",
    opts.write,
  );
  return {
    journalPath,
    receiptPath,
    journal,
    signer,
    evidenceSecurityDir: opts.evidenceSecurityDir,
    write: opts.write,
  };
}

export async function resumePreparedLiveEraseEvidence(
  rootInput: string,
  selectors: NormalizedForgetSelectors,
  opts: {
    readonly now?: Date;
    readonly evidenceSecurityDir?: string;
    readonly signerFactory?: EvidenceSignerFactory;
    readonly write?: EvidenceWrite;
  },
): Promise<LiveEraseResume | null> {
  const root = await realpath(rootInput);
  const pending = await findPendingPreparedLiveErase(root, selectors, opts.evidenceSecurityDir);
  if (!pending) return null;
  const { journalPath, receiptPath, journal } = pending;

  let receipt: PersistedLiveEraseReceipt;
  const state = await classifyPreparedLiveEraseState(root, journalPath, journal);
  const signer = await (opts.signerFactory ?? createEvidenceSigner)(opts.evidenceSecurityDir);
  if (signer.keyId !== journal.evidenceKeyId) {
    throw new Error("memory forget: prepared live erase journal evidence key ID does not match this device");
  }
  const prepared = {
    journalPath,
    receiptPath,
    journal,
    signer,
    evidenceSecurityDir: opts.evidenceSecurityDir,
    write: opts.write,
  } satisfies PreparedLiveEraseEvidence;
  if (state === "prepared") {
    return { state: "restart-prepared", prepared };
  }
  receipt = await finalizeLiveEraseEvidence(prepared, root, opts.now);
  return {
    state: "completed",
    plan: clonePlan(journal.plan),
    erased: erasedFromPlan(journal.plan),
    rewritten: [...journal.plan.rewrittenFacts].sort(),
    receipt,
  };
}

export function assertPreparedLiveEraseRestart(
  prepared: PreparedLiveEraseEvidence,
  plan: ForgetPlan,
  contentFingerprints: ContentFingerprintEvidence,
): void {
  if (stableJson(clonePlan(plan)) !== stableJson(prepared.journal.plan)
    || stableJson(contentFingerprints) !== stableJson(prepared.journal.selection.contentFingerprints)) {
    throw new LiveEraseEvidencePendingError(
      prepared.journalPath,
      "restore the live state to the signed prepared plan before retrying",
      "no additional destructive mutation was attempted because the current live erase plan or selected-content fingerprints no longer match the signed prepared journal",
    );
  }
}

export async function finalizeLiveEraseEvidence(
  prepared: PreparedLiveEraseEvidence,
  rootInput: string,
  now?: Date,
): Promise<PersistedLiveEraseReceipt> {
  const root = await realpath(rootInput);
  try {
    await validateLiveErasePostconditions(root, prepared.journal);
    const generation = readIndexGeneration(root);
    const payload: LiveEraseReceiptPayload = {
      schemaVersion: 2,
      kind: "memory-fort-live-erase",
      evidenceId: prepared.journal.evidenceId,
      operationId: prepared.journal.operationId,
      completedAt: (now ?? new Date()).toISOString(),
      status: "live-erased/history-retained",
      selection: prepared.journal.selection,
      repository: prepared.journal.repository,
      canonicalRootFingerprint: prepared.journal.canonicalRootFingerprint,
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
    await persistVerifiedSignedEvidence(
      prepared.receiptPath,
      payload,
      prepared.signer,
      prepared.evidenceSecurityDir,
      "live erase receipt",
      prepared.write,
    );
    const receipt = await readLiveEraseReceipt(prepared.receiptPath, prepared.evidenceSecurityDir);
    assertReceiptMatchesJournal(receipt, prepared.journal);
    return persistedReceipt(prepared.receiptPath, receipt);
  } catch (error) {
    const verified = await readPreparedJournal(prepared.journalPath, prepared.evidenceSecurityDir);
    assertPreparedJournalMatches(
      verified,
      root,
      prepared.journal.selection.selectors,
    );
    const detail = error instanceof Error ? error.message : String(error);
    throw new LiveEraseEvidencePendingError(
      prepared.journalPath,
      `rerun ${prepared.journal.recovery.command}`,
      detail,
    );
  }
}

async function validateLiveErasePostconditions(
  root: string,
  journal: LiveErasePreparedJournal,
): Promise<void> {
  const generation = readIndexGeneration(root);
  if (generation.state !== "ready") {
    throw new Error("index is not ready");
  }
  if (await readForgetRecovery(root)) {
    throw new Error("forget recovery is still pending");
  }
  for (const relPath of erasedFromPlan(journal.plan)) {
    if (existsSync(join(root, ...relPath.split("/")))) {
      throw new Error(`removed path is still present: ${relPath}`);
    }
  }
  for (const relPath of journal.plan.rewrittenFacts) {
    if (!existsSync(join(root, ...relPath.split("/")))) {
      throw new Error(`rewritten fact path is missing: ${relPath}`);
    }
  }
}

async function classifyPreparedLiveEraseState(
  root: string,
  journalPath: string,
  journal: LiveErasePreparedJournal,
): Promise<"completed" | "prepared"> {
  const generation = readIndexGeneration(root);
  const recovery = await readForgetRecovery(root);
  const erased = erasedFromPlan(journal.plan);
  const present = erased.filter((relPath) => existsSync(join(root, ...relPath.split("/"))));
  const missing = erased.filter((relPath) => !existsSync(join(root, ...relPath.split("/"))));
  const missingRewrites = journal.plan.rewrittenFacts
    .filter((relPath) => !existsSync(join(root, ...relPath.split("/"))));
  const repository = await readRepositoryIdentity(root);
  const repositoryMatches = stableJson(repository) === stableJson(journal.repository);

  if (generation.state === "ready" && !recovery && repositoryMatches
    && missing.length === erased.length && missingRewrites.length === 0) {
    return "completed";
  }
  let fingerprintsMatch = false;
  if (generation.state === "ready" && !recovery && repositoryMatches
    && present.length === erased.length && missingRewrites.length === 0) {
    const fingerprints = await collectSelectedContentFingerprints(
      root,
      journal.plan.raw,
      journal.selection.contentFingerprints.maxCount,
    );
    fingerprintsMatch = stableJson(fingerprints) === stableJson(journal.selection.contentFingerprints);
    if (fingerprintsMatch) {
      return "prepared";
    }
  }

  const detail = generation.state !== "ready" || recovery
    ? "no additional destructive mutation was attempted because the prepared operation is not at a ready boundary; complete the reported reindex recovery before retrying"
    : !repositoryMatches
      ? "no additional destructive mutation was attempted because the current repository identity no longer matches the signed prepared journal"
      : !fingerprintsMatch && present.length === erased.length && missingRewrites.length === 0
        ? "no additional destructive mutation was attempted because the selected-content fingerprints no longer match the signed prepared journal"
        : `no additional destructive mutation was attempted because the prepared operation is in an ambiguous mixed state (${present.length} removal targets present, ${missing.length} absent, ${missingRewrites.length} rewritten targets missing)`;
  throw new LiveEraseEvidencePendingError(
    journalPath,
    "inspect or restore the signed prepared plan before retrying",
    detail,
  );
}

async function readPreparedJournal(
  path: string,
  evidenceSecurityDir?: string,
): Promise<LiveErasePreparedJournal> {
  const value = await readVerifiedEvidenceFile(path, evidenceSecurityDir, "live erase prepared journal");
  if (!isPreparedJournal(value)) {
    throw new Error("memory forget: live erase prepared journal schema is invalid");
  }
  return value;
}

async function findPendingPreparedLiveErase(
  root: string,
  selectors: NormalizedForgetSelectors,
  evidenceSecurityDir?: string,
): Promise<{ journalPath: string; receiptPath: string; journal: LiveErasePreparedJournal } | null> {
  const operationsRoot = join(resolveEvidenceRecordsRoot(evidenceSecurityDir), "live-erase");
  if (!existsSync(operationsRoot)) return null;
  const pending: Array<{ journalPath: string; receiptPath: string; journal: LiveErasePreparedJournal }> = [];
  for (const entry of await readdir(operationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const operationDir = join(operationsRoot, entry.name);
    const journalPath = join(operationDir, "prepared.json");
    const receiptPath = join(operationDir, "receipt.json");
    if (!existsSync(journalPath) || existsSync(receiptPath)) continue;
    assertExternalEvidencePath(root, journalPath, "live erase prepared journal");
    assertExternalEvidencePath(root, receiptPath, "live erase receipt");
    const candidate = await readUnverifiedPreparedJournalIdentity(journalPath);
    if (!candidate
      || candidate.canonicalRootFingerprint !== pathFingerprint(root)
      || stableJson(candidate.selectors) !== stableJson(cloneSelectors(selectors))) {
      continue;
    }
    const journal = await readPreparedJournal(journalPath, evidenceSecurityDir);
    assertPreparedJournalMatches(journal, root, selectors);
    pending.push({ journalPath, receiptPath, journal });
  }
  if (pending.length > 1) {
    throw new Error("memory forget: multiple pending live erase journals match this selector set; inspect signed evidence before retrying");
  }
  return pending[0] ?? null;
}

async function readUnverifiedPreparedJournalIdentity(
  journalPath: string,
): Promise<{ canonicalRootFingerprint: string; selectors: unknown } | null> {
  try {
    const value: unknown = JSON.parse(await readFile(journalPath, "utf8"));
    if (!isRecord(value) || typeof value["canonicalRootFingerprint"] !== "string" || !isRecord(value["selection"])) {
      return null;
    }
    return {
      canonicalRootFingerprint: value["canonicalRootFingerprint"],
      selectors: value["selection"]["selectors"],
    };
  } catch {
    return null;
  }
}

function assertPreparedJournalMatches(
  journal: LiveErasePreparedJournal,
  root: string,
  selectors: NormalizedForgetSelectors,
): void {
  const expectedOperationDigests = new Set([
    liveEraseOperationDigest(root, journal.selection.digest),
    legacyLiveEraseOperationDigest(root, selectors),
  ]);
  if (!expectedOperationDigests.has(journal.operationDigest)
    || journal.canonicalRootFingerprint !== pathFingerprint(root)
    || stableJson(journal.selection.selectors) !== stableJson(cloneSelectors(selectors))) {
    throw new Error("memory forget: prepared live erase journal does not match this root and exact selector set");
  }
  if (journal.selection.digest !== forgetSelectionDigest(journal.selection.selectors, journal.selection.targets)) {
    throw new Error("memory forget: prepared live erase journal selection digest is invalid");
  }
}

function assertReceiptMatchesJournal(receipt: LiveEraseReceipt, journal: LiveErasePreparedJournal): void {
  if (receipt.evidenceId !== journal.evidenceId
    || receipt.operationId !== journal.operationId
    || receipt.selection.digest !== journal.selection.digest
    || receipt.canonicalRootFingerprint !== journal.canonicalRootFingerprint) {
    throw new Error("memory forget: live erase receipt does not match its prepared journal");
  }
}

function persistedReceipt(path: string, receipt: LiveEraseReceipt): PersistedLiveEraseReceipt {
  return {
    path,
    evidenceId: receipt.evidenceId,
    operationId: receipt.operationId,
    completedAt: receipt.completedAt,
    selectionDigest: receipt.selection.digest,
  };
}

function liveEraseOperationDigest(root: string, selectionDigest: string): string {
  return sha256Text(stableJson({
    kind: "memory-fort-live-erase-operation-v2",
    canonicalRootFingerprint: pathFingerprint(root),
    selectionDigest,
  }));
}

function legacyLiveEraseOperationDigest(root: string, selectors: NormalizedForgetSelectors): string {
  return sha256Text(stableJson({
    kind: "memory-fort-live-erase-operation-v1",
    canonicalRootFingerprint: pathFingerprint(root),
    selectors: cloneSelectors(selectors),
  }));
}

function targetsFromPlan(plan: ForgetPlan): LiveEraseReceiptPayload["selection"]["targets"] {
  return {
    raw: [...plan.raw],
    facts: [...plan.facts],
    rewrittenFacts: [...plan.rewrittenFacts],
    generated: [...plan.generated],
    retainedArchives: [...plan.archive],
  };
}

function erasedFromPlan(plan: ForgetPlan): string[] {
  return [...plan.raw, ...plan.facts, ...plan.generated].sort();
}

function cloneSelectors(selectors: NormalizedForgetSelectors): NormalizedForgetSelectors {
  return {
    paths: [...selectors.paths],
    rawPaths: [...selectors.rawPaths],
    sourceIds: [...selectors.sourceIds],
  };
}

function clonePlan(plan: ForgetPlan): ForgetPlan {
  return JSON.parse(JSON.stringify(plan)) as ForgetPlan;
}

function formatRetryCommand(selectors: NormalizedForgetSelectors): string {
  const flags = [
    ...selectors.paths.map((path) => `--path ${JSON.stringify(path)}`),
    ...selectors.rawPaths.map((path) => `--raw ${JSON.stringify(path)}`),
    ...selectors.sourceIds.map((source) => `--source ${JSON.stringify(source)}`),
  ];
  return `memory forget --apply ${flags.join(" ")}`.trim();
}

function isPreparedJournal(value: unknown): value is LiveErasePreparedJournal {
  if (!isRecord(value)
    || value["schemaVersion"] !== 1
    || value["kind"] !== "memory-fort-live-erase-prepared"
    || value["status"] !== "prepared"
    || typeof value["evidenceId"] !== "string"
    || typeof value["operationId"] !== "string"
    || typeof value["preparedAt"] !== "string"
    || typeof value["operationDigest"] !== "string"
    || typeof value["evidenceKeyId"] !== "string"
    || typeof value["canonicalRootFingerprint"] !== "string"
    || !isRecord(value["selection"])
    || !isRecord(value["plan"])
    || !isRecord(value["repository"])
    || !isRecord(value["intendedPostconditions"])
    || !isRecord(value["recovery"])
    || !isRecord(value["auth"])) {
    return false;
  }
  const selection = value["selection"];
  const plan = value["plan"];
  return typeof selection["digest"] === "string"
    && isRecord(selection["selectors"])
    && isRecord(selection["targets"])
    && isRecord(selection["contentFingerprints"])
    && isStringArray(plan["raw"])
    && isStringArray(plan["facts"])
    && isStringArray(plan["rewrittenFacts"])
    && isStringArray(plan["generated"])
    && isStringArray(plan["archive"]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
