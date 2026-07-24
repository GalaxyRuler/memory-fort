import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import type {
  ForgetPlan,
  NormalizedForgetSelectors,
} from "../cli/commands/forget.js";
import { readIndexGeneration } from "../index/generation.js";
import type { ContentFingerprintEvidence } from "./content-fingerprints.js";
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
  readonly plan: ForgetPlan;
  readonly erased: string[];
  readonly rewritten: string[];
  readonly receipt: PersistedLiveEraseReceipt;
}

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
  const operationDigest = liveEraseOperationDigest(root, opts.selectors);
  const operationDir = evidenceOperationDir("live-erase", operationDigest, opts.evidenceSecurityDir);
  const journalPath = join(operationDir, "prepared.json");
  const receiptPath = join(operationDir, "receipt.json");
  assertExternalEvidencePath(root, journalPath, "live erase prepared journal");
  assertExternalEvidencePath(root, receiptPath, "live erase receipt");
  if (existsSync(journalPath)) {
    throw new Error(
      `memory forget: a prepared live erase journal already exists at ${journalPath}; rerun the same forget --apply command to recover`,
    );
  }

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
): Promise<ResumedLiveEraseEvidence | null> {
  const root = await realpath(rootInput);
  const operationDigest = liveEraseOperationDigest(root, selectors);
  const operationDir = evidenceOperationDir("live-erase", operationDigest, opts.evidenceSecurityDir);
  const journalPath = join(operationDir, "prepared.json");
  if (!existsSync(journalPath)) return null;
  const receiptPath = join(operationDir, "receipt.json");
  assertExternalEvidencePath(root, journalPath, "live erase prepared journal");
  assertExternalEvidencePath(root, receiptPath, "live erase receipt");
  const journal = await readPreparedJournal(journalPath, opts.evidenceSecurityDir);
  assertPreparedJournalMatches(journal, root, selectors, operationDigest);

  let receipt: PersistedLiveEraseReceipt;
  if (existsSync(receiptPath)) {
    const persisted = await readLiveEraseReceipt(receiptPath, opts.evidenceSecurityDir);
    assertReceiptMatchesJournal(persisted, journal);
    await validateLiveErasePostconditions(root, journal);
    receipt = persistedReceipt(receiptPath, persisted);
  } else {
    const signer = await (opts.signerFactory ?? createEvidenceSigner)(opts.evidenceSecurityDir);
    if (signer.keyId !== journal.evidenceKeyId) {
      throw new Error("memory forget: prepared live erase journal evidence key ID does not match this device");
    }
    receipt = await finalizeLiveEraseEvidence({
      journalPath,
      receiptPath,
      journal,
      signer,
      evidenceSecurityDir: opts.evidenceSecurityDir,
      write: opts.write,
    }, root, opts.now);
  }
  return {
    plan: clonePlan(journal.plan),
    erased: erasedFromPlan(journal.plan),
    rewritten: [...journal.plan.rewrittenFacts].sort(),
    receipt,
  };
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
      prepared.journal.operationDigest,
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

function assertPreparedJournalMatches(
  journal: LiveErasePreparedJournal,
  root: string,
  selectors: NormalizedForgetSelectors,
  operationDigest: string,
): void {
  if (journal.operationDigest !== operationDigest
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

function liveEraseOperationDigest(root: string, selectors: NormalizedForgetSelectors): string {
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
