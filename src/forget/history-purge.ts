import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  normalizeForgetSelectors,
  type ForgetOptions,
  type NormalizedForgetSelectors,
} from "../cli/commands/forget.js";
import {
  verifyBackup,
  type RestoreDrillEvidence,
} from "../cli/commands/backup.js";
import { readIndexGeneration } from "../index/generation.js";
import { memoryRoot } from "../storage/paths.js";
import {
  hasSelectedContentFingerprint,
  scrubSelectedContentFingerprints,
  type ContentFingerprintEvidence,
} from "./content-fingerprints.js";
import {
  createEvidenceSigner,
  EVIDENCE_KEY_LIMITATION,
  stableJson,
  verifyEvidenceSignature,
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
import {
  forgetSelectionDigest,
  isRepositoryRefEvidence,
  pathFingerprint,
  readLiveEraseReceipt,
  readRepositoryIdentity,
  repositoryFingerprint,
  sha256Text,
  type LiveEraseReceipt,
  type RepositoryIdentity,
} from "./evidence.js";
import { readForgetRecovery } from "./recovery.js";

const EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export const PURGE_HISTORY_CONFIRMATION =
  "I UNDERSTAND THIS REWRITES LOCAL GIT HISTORY; REMOTES, OTHER CLONES, REFLOGS, UNREACHABLE OBJECTS, AND BACKUPS REMAIN";

const LIMITATIONS = [
  "Remote refs and hosted repositories were not updated or purged.",
  "Other clones were not purged.",
  "Reflogs were retained and can still reference pre-rewrite commits.",
  "Backup archives and manifests were not deleted or overwritten.",
  "Cryptographic commit signatures and nonstandard commit headers are not preserved by the local rewrite.",
  "Unreachable objects remain until manual garbage collection (after separately approved reflog expiry).",
  "Local refs outside the itemized refs were not rewritten.",
  EVIDENCE_KEY_LIMITATION,
] as const;

const MANUAL_NEXT_STEPS = [
  "Review the receipt and rewritten local refs before any publication.",
  "Coordinate any remote history replacement manually; this command never force-pushes.",
  "Handle other clones independently after remote publication is deliberately approved.",
  "Decide separately whether retained backups may ever be destroyed.",
  "Expire reflogs and run garbage collection only as a separate, deliberate local step.",
] as const;

export interface HistoryPurgeOptions
  extends Pick<ForgetOptions, "paths" | "rawPaths" | "sourceIds"> {
  readonly repositoryRoot?: string;
  readonly refs: readonly string[];
  readonly liveEraseReceiptPath: string;
  readonly restoreDrillEvidencePath: string;
  readonly disposableClone?: boolean;
  readonly confirmation?: string;
  readonly now?: Date;
  readonly evidenceSecurityDir?: string;
  readonly evidenceSignerFactory?: EvidenceSignerFactory;
  readonly evidenceWrite?: EvidenceWrite;
}

export interface HistoryPurgeRefResult {
  readonly name: string;
  readonly before: string;
  readonly after: string;
}

export interface HistoryPurgeResult {
  readonly status: "planned" | "purged-local-history/limited-scope";
  readonly selectionDigest: string;
  readonly refs: HistoryPurgeRefResult[];
  readonly receiptPath?: string;
  readonly report: string;
}

export interface HistoryPurgeReceiptPayload {
  readonly schemaVersion: 2;
  readonly kind: "memory-fort-history-purge";
  readonly evidenceId: string;
  readonly operationId: string;
  readonly completedAt: string;
  readonly status: "purged-local-history/limited-scope";
  readonly preconditions: {
    readonly liveEraseEvidenceId: string;
    readonly liveEraseCompletedAt: string;
    readonly restoreDrillEvidenceId: string;
    readonly restoreDrillCompletedAt: string;
    readonly repositoryFingerprint: string;
    readonly cleanDisposableClone: true;
    readonly confirmation: "exact-consequence-phrase";
  };
  readonly selection: {
    readonly digest: string;
    readonly contentFingerprints: ContentFingerprintEvidence;
    readonly additionalAffectedPaths: string[];
    readonly targetCount: number;
    readonly targetPathDigests: string[];
  };
  readonly refs: HistoryPurgeRefResult[];
  readonly objects: {
    readonly commitsVisited: number;
    readonly commitsRewritten: number;
    readonly commitMapDigest: string;
    readonly beforeTargetObjectCount: number;
    readonly beforeTargetObjectDigest: string;
    readonly afterTargetObjectCount: number;
    readonly afterTargetObjectDigest: string;
  };
  readonly validation: {
    readonly passed: true;
    readonly commands: Array<{
      readonly command: string;
      readonly result: "passed";
    }>;
  };
  readonly limitations: string[];
  readonly manualNextSteps: string[];
  readonly operationEvidencePath: string;
}

export type HistoryPurgeReceipt = HistoryPurgeReceiptPayload & {
  readonly auth: EvidenceAuth;
};

export class HistoryPurgePartialError extends Error {

  readonly receiptPath: string;

  constructor(message: string, receiptPath: string) {
    super(message);
    this.name = "HistoryPurgePartialError";
    this.receiptPath = receiptPath;
  }
}

export class HistoryPurgeEvidencePendingError extends Error {
  readonly journalPath: string;
  readonly recoveryAction: string;

  constructor(journalPath: string, recoveryAction: string, detail: string) {
    super(
      `memory forget --purge-history: final evidence is pending after refs moved; verified prepared journal: ${journalPath}; ${recoveryAction}; ${detail}`,
    );
    this.name = "HistoryPurgeEvidencePendingError";
    this.journalPath = journalPath;
    this.recoveryAction = recoveryAction;
  }
}

interface PurgeTargets {
  readonly fullDelete: string[];
  readonly factRewrite: string[];
  readonly all: string[];
}

interface RefBefore {
  readonly name: string;
  readonly before: string;
}

interface FileEvidence {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface Preflight {
  readonly root: string;
  readonly identity: RepositoryIdentity;
  readonly canonicalRoot: string;
  readonly liveReceipt: LiveEraseReceipt;
  readonly drillEvidence: RestoreDrillEvidence;
  readonly selectors: NormalizedForgetSelectors;
  readonly refs: RefBefore[];
  readonly currentRef: string;
  readonly targets: PurgeTargets;
  readonly remoteRefsDigest: string;
  readonly localConfigDigest: string;
  readonly additionalAffectedPaths: string[];
  readonly evidenceSecurityDir?: string;
  readonly protectedEvidence: FileEvidence[];
  readonly beforeObjects: ObjectEvidence;
}

interface ObjectEvidence {
  readonly count: number;
  readonly digest: string;
}

interface HistoryPurgePreparedPayload {
  readonly schemaVersion: 1;
  readonly kind: "memory-fort-history-purge-prepared";
  readonly evidenceId: string;
  readonly operationId: string;
  readonly preparedAt: string;
  readonly status: "prepared";
  readonly operationDigest: string;
  readonly evidenceKeyId: string;
  readonly selectionDigest: string;
  readonly selectors: NormalizedForgetSelectors;
  readonly refs: HistoryPurgeRefResult[];
  readonly cloneIdentity: RepositoryIdentity;
  readonly canonicalRootFingerprint: string;
  readonly currentRef: string;
  readonly evidence: {
    readonly liveEraseReceiptPath: string;
    readonly liveEraseEvidenceId: string;
    readonly restoreDrillEvidencePath: string;
    readonly restoreDrillEvidenceId: string;
    readonly backupArchiveSha256: string;
    readonly backupManifestSha256: string;
  };
  readonly preflight: {
    readonly targets: PurgeTargets;
    readonly remoteRefsDigest: string;
    readonly localConfigDigest: string;
    readonly additionalAffectedPaths: string[];
    readonly protectedEvidence: FileEvidence[];
    readonly beforeObjects: ObjectEvidence;
  };
  readonly rewrite: {
    readonly commitsVisited: number;
    readonly commitsRewritten: number;
    readonly commitMapDigest: string;
  };
  readonly validationPlan: string[];
  readonly recovery: {
    readonly action: "rerun-identical-purge-command";
    readonly instructions: string[];
  };
}

type HistoryPurgePreparedJournal = HistoryPurgePreparedPayload & {
  readonly auth: EvidenceAuth;
};

interface PreparedHistoryPurgeEvidence {
  readonly journalPath: string;
  readonly receiptPath: string;
  readonly journal: HistoryPurgePreparedJournal;
  readonly signer: EvidenceSigner;
  readonly evidenceSecurityDir?: string;
  readonly write?: EvidenceWrite;
}

interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: GitIdentity;
  readonly committer: GitIdentity;
  readonly message: Buffer;
  readonly signed: boolean;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: "blob" | "commit";
  readonly objectId: string;
  readonly path: string;
}

interface GitIdentity {
  readonly name: string;
  readonly email: string;
  readonly date: string;
}

interface GitRunOptions {
  readonly input?: Buffer | string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runHistoryPurge(
  opts: HistoryPurgeOptions,
): Promise<HistoryPurgeResult> {
  if (opts.confirmation === PURGE_HISTORY_CONFIRMATION) {
    const resumed = await resumePreparedHistoryPurge(opts);
    if (resumed) return resumed;
  }
  const preflight = await buildPreflight(opts);
  if (opts.confirmation === undefined) {
    return {
      status: "planned",
      selectionDigest: preflight.liveReceipt.selection.digest,
      refs: preflight.refs.map((ref) => ({ ...ref, after: ref.before })),
      report: formatPurgePlan(preflight),
    };
  }
  if (opts.confirmation !== PURGE_HISTORY_CONFIRMATION) {
    throw new Error(
      `memory forget --purge-history: confirmation phrase does not match; required confirmation phrase: ${PURGE_HISTORY_CONFIRMATION}`,
    );
  }
  return executeHistoryPurge(preflight, opts, opts.now ?? new Date());
}

async function buildPreflight(opts: HistoryPurgeOptions): Promise<Preflight> {
  if (!opts.liveEraseReceiptPath) {
    throw new Error("memory forget --purge-history: a live erase receipt path is required");
  }
  if (!opts.restoreDrillEvidencePath) {
    throw new Error("memory forget --purge-history: restore drill evidence is required");
  }
  const now = opts.now ?? new Date();
  const selectors = normalizeForgetSelectors(opts);
  if (selectors.paths.length + selectors.rawPaths.length + selectors.sourceIds.length === 0) {
    throw new Error("memory forget --purge-history: provide the exact live erase selection");
  }
  const liveReceipt = await readLiveEraseReceipt(
    opts.liveEraseReceiptPath,
    opts.evidenceSecurityDir,
  );
  assertFreshEvidence("live erase receipt", liveReceipt.completedAt, now);
  if (!liveReceipt.selection.contentFingerprints.coverageComplete) {
    const reason = liveReceipt.selection.contentFingerprints.coverageReason;
    throw new Error(
      `memory forget --purge-history: live erase fingerprint coverage is incomplete (${reason}); no history rewrite is allowed`,
    );
  }
  if (liveReceipt.repository === null) {
    throw new Error("memory forget --purge-history: live erase receipt has no Git repository evidence");
  }
  if (!sameSelectors(selectors, liveReceipt.selection.selectors)) {
    throw new Error("memory forget --purge-history: selectors do not match the exact live erase selection");
  }
  if (liveReceipt.selection.digest !== forgetSelectionDigest(selectors, liveReceipt.selection.targets)) {
    throw new Error("memory forget --purge-history: selectors do not match the exact live erase selection");
  }

  const canonicalRoot = await realpath(memoryRoot());
  if (pathFingerprint(canonicalRoot) !== liveReceipt.canonicalRootFingerprint) {
    throw new Error("memory forget --purge-history: live erase receipt canonical vault fingerprint does not match");
  }
  await validateCurrentLiveEraseState(canonicalRoot, liveReceipt);
  const canonicalIdentity = await readRepositoryIdentity(canonicalRoot);
  if (!canonicalIdentity
    || canonicalIdentity.head !== liveReceipt.repository.head
    || canonicalIdentity.fingerprint !== liveReceipt.repository.fingerprint
    || canonicalIdentity.commonGitDirFingerprint !== liveReceipt.repository.commonGitDirFingerprint) {
    throw new Error("memory forget --purge-history: canonical repository no longer matches the live erase receipt");
  }

  const drillEvidence = await readRestoreDrillEvidence(
    opts.restoreDrillEvidencePath,
    opts.evidenceSecurityDir,
  );
  assertFreshEvidence("restore drill evidence", drillEvidence.completedAt, now);
  assertFreshEvidence("backup archive", drillEvidence.archive.createdAt, now);
  if (drillEvidence.repository.head === null
    || drillEvidence.repository.fingerprint === null
    || drillEvidence.repository.refs === null) {
    throw new Error("memory forget --purge-history: restore drill evidence has no Git repository fingerprint");
  }
  if (drillEvidence.repository.fingerprint !== liveReceipt.repository.fingerprint
    || drillEvidence.repository.head !== liveReceipt.repository.head) {
    throw new Error("memory forget --purge-history: restore drill repository fingerprint does not match the live erase");
  }
  const verifiedBackup = await verifyBackup(drillEvidence.archive.path);
  if (verifiedBackup.archiveSha256 !== drillEvidence.archive.sha256
    || verifiedBackup.manifestSha256 !== drillEvidence.archive.manifestSha256
    || verifiedBackup.gitHead !== drillEvidence.repository.head
    || verifiedBackup.createdAt !== drillEvidence.archive.createdAt
    || (verifiedBackup.gitHead
      && repositoryFingerprint(
        verifiedBackup.gitHead,
        drillEvidence.repository.refs,
      ) !== drillEvidence.repository.fingerprint)) {
    throw new Error("memory forget --purge-history: restore drill evidence does not match a freshly verified backup");
  }

  if (!opts.disposableClone) {
    throw new Error("memory forget --purge-history: --disposable-clone is required before any rewrite");
  }
  const root = await realpath(opts.repositoryRoot ?? memoryRoot());
  const identity = await readRepositoryIdentity(root);
  if (!identity) {
    throw new Error("memory forget --purge-history: target is not a Git working repository");
  }
  if (identity.rootFingerprint === liveReceipt.repository.rootFingerprint
    || identity.commonGitDirFingerprint === liveReceipt.repository.commonGitDirFingerprint
    || identity.rootFingerprint === liveReceipt.canonicalRootFingerprint) {
    throw new Error("memory forget --purge-history: refused to rewrite the canonical repository; use a separate disposable clone");
  }
  assertRepositoryRefBindings(
    identity.refs,
    liveReceipt.repository.refs,
    drillEvidence.repository.refs,
  );
  if (identity.head !== liveReceipt.repository.head
    || identity.fingerprint !== liveReceipt.repository.fingerprint
    || identity.fingerprint !== drillEvidence.repository.fingerprint) {
    throw new Error("memory forget --purge-history: disposable clone repository fingerprint does not match the evidence");
  }
  await assertCleanRepository(root);
  await assertNoUnsafeGitOperation(root);

  const refs = await resolveScopedRefs(root, opts.refs);
  for (const ref of refs) {
    if (liveReceipt.repository.refs.heads[ref.name] !== ref.before
      || drillEvidence.repository.refs.heads[ref.name] !== ref.before) {
      throw new Error(`memory forget --purge-history: ${ref.name} tip does not match both signed evidence records`);
    }
  }
  const currentRef = await currentBranchRef(root);
  if (!refs.some((ref) => ref.name === currentRef)) {
    throw new Error("memory forget --purge-history: the checked-out branch must be included in the itemized refs");
  }
  const targets = purgeTargets(liveReceipt);
  validatePurgeTargets(targets);
  const matchedPaths = await scanHistoryFingerprintMatches(
    root,
    refs.map((ref) => ref.name),
    liveReceipt.selection.contentFingerprints,
  );
  const additionalAffectedPaths = matchedPaths.filter((path) => !targets.all.includes(path));
  const protectedEvidence = await Promise.all([
    snapshotFile(drillEvidence.archive.path, "backup archive"),
    snapshotFile(opts.restoreDrillEvidencePath, "restore drill evidence"),
    snapshotFile(opts.liveEraseReceiptPath, "live erase receipt"),
  ]);
  const remoteRefsDigest = sha256Text(await gitText(root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes",
  ]));
  const localConfigDigest = sha256Text(await gitText(root, ["config", "--local", "--null", "--list"]));
  const beforeObjects = await targetObjectEvidence(
    root,
    refs.map((ref) => ref.name),
    targets.all,
  );
  return {
    root,
    identity,
    canonicalRoot,
    liveReceipt,
    drillEvidence,
    selectors,
    refs,
    currentRef,
    targets,
    remoteRefsDigest,
    localConfigDigest,
    additionalAffectedPaths,
    evidenceSecurityDir: opts.evidenceSecurityDir,
    protectedEvidence,
    beforeObjects,
  };
}

async function executeHistoryPurge(
  preflight: Preflight,
  opts: HistoryPurgeOptions,
  now: Date,
): Promise<HistoryPurgeResult> {
  const operationDigest = historyPurgeOperationDigest(preflight.root, preflight.selectors, opts);
  const operationDir = evidenceOperationDir("history-purge", operationDigest, opts.evidenceSecurityDir);
  const journalPath = join(operationDir, "prepared.json");
  const receiptPath = join(operationDir, "receipt.json");
  const indexPath = join(operationDir, "rewrite.index");
  assertExternalEvidencePath(preflight.root, journalPath, "history purge prepared journal");
  assertExternalEvidencePath(preflight.canonicalRoot, journalPath, "history purge prepared journal");
  assertExternalEvidencePath(preflight.root, receiptPath, "history purge receipt");
  assertExternalEvidencePath(preflight.canonicalRoot, receiptPath, "history purge receipt");
  await mkdir(operationDir, { recursive: true });

  const operationId = randomUUID();
  const evidenceId = randomUUID();
  const commitMap = new Map<string, string>();
  let prepared: PreparedHistoryPurgeEvidence | null = null;
  let refsUpdated = false;
  let phase = "object-rewrite";
  try {
    const commits = splitLines(await gitText(preflight.root, [
      "rev-list",
      "--reverse",
      "--topo-order",
      ...preflight.refs.map((ref) => ref.name),
    ]));
    for (const commit of commits) {
      const parsed = parseCommit(await gitBuffer(preflight.root, ["cat-file", "commit", commit]));
      const rewrittenTree = await rewriteTree(
        preflight.root,
        parsed.tree,
        indexPath,
        preflight.targets,
        new Set(preflight.liveReceipt.selection.targets.raw),
        preflight.liveReceipt.selection.contentFingerprints,
      );
      const rewrittenParents = parsed.parents.map((parent) => {
        const rewritten = commitMap.get(parent);
        if (!rewritten) {
          throw new Error("memory forget --purge-history: commit topology could not be rewritten safely");
        }
        return rewritten;
      });
      const rewrittenCommit = await writeCommit(
        preflight.root,
        rewrittenTree,
        rewrittenParents,
        parsed,
      );
      commitMap.set(commit, rewrittenCommit);
    }
    const rewrittenRefs = preflight.refs.map((ref) => {
      const after = commitMap.get(ref.before);
      if (!after) throw new Error(`memory forget --purge-history: no rewritten tip was created for ${ref.name}`);
      return { name: ref.name, before: ref.before, after };
    });

    phase = "external-journal-preparation";
    const signer = await (opts.evidenceSignerFactory ?? createEvidenceSigner)(opts.evidenceSecurityDir);
    const journalPayload = historyPurgePreparedPayload(
      preflight,
      opts,
      operationDigest,
      operationId,
      evidenceId,
      rewrittenRefs,
      commitMap,
      signer.keyId,
      now,
    );
    const journal = await persistVerifiedSignedEvidence(
      journalPath,
      journalPayload,
      signer,
      opts.evidenceSecurityDir,
      "history purge prepared journal",
      opts.evidenceWrite,
    );
    prepared = {
      journalPath,
      receiptPath,
      journal,
      signer,
      evidenceSecurityDir: opts.evidenceSecurityDir,
      write: opts.evidenceWrite,
    };

    phase = "atomic-ref-update";
    await updateRefsAtomically(preflight.root, rewrittenRefs);
    refsUpdated = true;

    phase = "worktree-reset";
    const currentAfter = rewrittenRefs.find((ref) => ref.name === preflight.currentRef)!.after;
    await gitBuffer(preflight.root, ["reset", "--hard", currentAfter]);

    phase = "post-rewrite-validation";
    const validation = await validateRewrite(preflight, rewrittenRefs);
    const afterObjects = await targetObjectEvidence(
      preflight.root,
      rewrittenRefs.map((ref) => ref.name),
      preflight.targets.all,
    );
    phase = "final-evidence";
    return await persistFinalHistoryPurgeReceipt(preflight, prepared, validation, afterObjects, now);
  } catch (error) {
    if (error instanceof HistoryPurgeEvidencePendingError
      || error instanceof HistoryPurgePartialError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    if (!refsUpdated) {
      const retained = prepared ? `; signed prepared journal retained at ${prepared.journalPath}` : "";
      throw new Error(
        `memory forget --purge-history: failed closed before any ref update during ${phase}${retained}: ${detail}`,
      );
    }
    if (!prepared) {
      throw new Error("memory forget --purge-history: refs moved without a prepared evidence journal");
    }
    return persistHistoryPurgePartialAndThrow(preflight, prepared, phase, detail, now);
  }
}

async function resumePreparedHistoryPurge(
  opts: HistoryPurgeOptions,
): Promise<HistoryPurgeResult | null> {
  const root = await realpath(opts.repositoryRoot ?? memoryRoot());
  const selectors = normalizeForgetSelectors(opts);
  if (selectors.paths.length + selectors.rawPaths.length + selectors.sourceIds.length === 0) return null;
  const operationDigest = historyPurgeOperationDigest(root, selectors, opts);
  const operationDir = evidenceOperationDir("history-purge", operationDigest, opts.evidenceSecurityDir);
  const journalPath = join(operationDir, "prepared.json");
  if (!existsSync(journalPath)) return null;
  const receiptPath = join(operationDir, "receipt.json");
  assertExternalEvidencePath(root, journalPath, "history purge prepared journal");
  assertExternalEvidencePath(root, receiptPath, "history purge receipt");
  const journal = await readPreparedHistoryPurgeJournal(journalPath, opts.evidenceSecurityDir);
  assertPreparedHistoryPurgeMatches(journal, root, selectors, opts, operationDigest);

  const tips = await Promise.all(journal.refs.map(async (ref) => ({
    ref,
    current: await gitText(root, ["rev-parse", ref.name]),
  })));
  const allBefore = tips.every(({ ref, current }) => current === ref.before);
  if (allBefore) return null;
  const allAfter = tips.every(({ ref, current }) => current === ref.after);
  const preflight = await resumePreflightFromJournal(opts, journal, root);
  const signer = await (opts.evidenceSignerFactory ?? createEvidenceSigner)(opts.evidenceSecurityDir);
  if (signer.keyId !== journal.evidenceKeyId) {
    throw new Error("memory forget --purge-history: prepared journal evidence key ID does not match this device");
  }
  const prepared: PreparedHistoryPurgeEvidence = {
    journalPath,
    receiptPath,
    journal,
    signer,
    evidenceSecurityDir: opts.evidenceSecurityDir,
    write: opts.evidenceWrite,
  };

  if (!allAfter) {
    await persistHistoryPurgePartialAndThrow(
      preflight,
      prepared,
      "resume-mixed-ref-state",
      "scoped refs are a mixture of prepared before and after tips; no ref was changed automatically",
      opts.now ?? new Date(),
    );
  }

  const currentAfter = journal.refs.find((ref) => ref.name === journal.currentRef)!.after;
  await gitBuffer(root, ["reset", "--hard", currentAfter]);
  const validation = await validateRewrite(preflight, journal.refs);
  const afterObjects = await targetObjectEvidence(
    root,
    journal.refs.map((ref) => ref.name),
    preflight.targets.all,
  );
  return persistFinalHistoryPurgeReceipt(
    preflight,
    prepared,
    validation,
    afterObjects,
    opts.now ?? new Date(),
  );
}

function historyPurgePreparedPayload(
  preflight: Preflight,
  opts: HistoryPurgeOptions,
  operationDigest: string,
  operationId: string,
  evidenceId: string,
  refs: HistoryPurgeRefResult[],
  commitMap: Map<string, string>,
  evidenceKeyId: string,
  now: Date,
): HistoryPurgePreparedPayload {
  return {
    schemaVersion: 1,
    kind: "memory-fort-history-purge-prepared",
    evidenceId,
    operationId,
    preparedAt: now.toISOString(),
    status: "prepared",
    operationDigest,
    evidenceKeyId,
    selectionDigest: preflight.liveReceipt.selection.digest,
    selectors: cloneSelectors(preflight.selectors),
    refs,
    cloneIdentity: preflight.identity,
    canonicalRootFingerprint: pathFingerprint(preflight.canonicalRoot),
    currentRef: preflight.currentRef,
    evidence: {
      liveEraseReceiptPath: resolve(opts.liveEraseReceiptPath),
      liveEraseEvidenceId: preflight.liveReceipt.evidenceId,
      restoreDrillEvidencePath: resolve(opts.restoreDrillEvidencePath),
      restoreDrillEvidenceId: preflight.drillEvidence.evidenceId,
      backupArchiveSha256: preflight.drillEvidence.archive.sha256,
      backupManifestSha256: preflight.drillEvidence.archive.manifestSha256,
    },
    preflight: {
      targets: preflight.targets,
      remoteRefsDigest: preflight.remoteRefsDigest,
      localConfigDigest: preflight.localConfigDigest,
      additionalAffectedPaths: preflight.additionalAffectedPaths,
      protectedEvidence: preflight.protectedEvidence,
      beforeObjects: preflight.beforeObjects,
    },
    rewrite: {
      commitsVisited: commitMap.size,
      commitsRewritten: [...commitMap.entries()].filter(([before, after]) => before !== after).length,
      commitMapDigest: sha256Text(
        [...commitMap.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([before, after]) => `${before}:${after}`)
          .join("\n"),
      ),
    },
    validationPlan: purgeValidationPlan(),
    recovery: {
      action: "rerun-identical-purge-command",
      instructions: [
        "Rerun the identical confirmed purge command in this disposable clone.",
        "All prepared after tips will be revalidated and finalized without another rewrite.",
        "Mixed before/after tips will produce a truthful signed partial receipt and will not be forced.",
      ],
    },
  };
}

async function persistFinalHistoryPurgeReceipt(
  preflight: Preflight,
  prepared: PreparedHistoryPurgeEvidence,
  validation: Array<{ command: string; result: "passed" }>,
  afterObjects: ObjectEvidence,
  now: Date,
): Promise<HistoryPurgeResult> {
  const journal = prepared.journal;
  const payload: HistoryPurgeReceiptPayload = {
    schemaVersion: 2,
    kind: "memory-fort-history-purge",
    evidenceId: journal.evidenceId,
    operationId: journal.operationId,
    completedAt: now.toISOString(),
    status: "purged-local-history/limited-scope",
    preconditions: {
      liveEraseEvidenceId: preflight.liveReceipt.evidenceId,
      liveEraseCompletedAt: preflight.liveReceipt.completedAt,
      restoreDrillEvidenceId: preflight.drillEvidence.evidenceId,
      restoreDrillCompletedAt: preflight.drillEvidence.completedAt,
      repositoryFingerprint: journal.cloneIdentity.fingerprint,
      cleanDisposableClone: true,
      confirmation: "exact-consequence-phrase",
    },
    selection: {
      digest: journal.selectionDigest,
      contentFingerprints: preflight.liveReceipt.selection.contentFingerprints,
      additionalAffectedPaths: journal.preflight.additionalAffectedPaths,
      targetCount: journal.preflight.targets.all.length,
      targetPathDigests: journal.preflight.targets.all.map((path) => sha256Text(path)).sort(),
    },
    refs: journal.refs,
    objects: {
      commitsVisited: journal.rewrite.commitsVisited,
      commitsRewritten: journal.rewrite.commitsRewritten,
      commitMapDigest: journal.rewrite.commitMapDigest,
      beforeTargetObjectCount: journal.preflight.beforeObjects.count,
      beforeTargetObjectDigest: journal.preflight.beforeObjects.digest,
      afterTargetObjectCount: afterObjects.count,
      afterTargetObjectDigest: afterObjects.digest,
    },
    validation: { passed: true, commands: validation },
    limitations: [...LIMITATIONS],
    manualNextSteps: [...MANUAL_NEXT_STEPS],
    operationEvidencePath: prepared.journalPath,
  };
  try {
    const receipt = await persistVerifiedSignedEvidence(
      prepared.receiptPath,
      payload,
      prepared.signer,
      prepared.evidenceSecurityDir,
      "history purge receipt",
      prepared.write,
    );
    if (receipt.kind !== "memory-fort-history-purge"
      || receipt.status !== "purged-local-history/limited-scope"
      || receipt.operationId !== journal.operationId) {
      throw new Error("history purge receipt read-back is not the prepared completed operation");
    }
  } catch (error) {
    throw await historyPurgePendingError(prepared, error);
  }
  return {
    status: "purged-local-history/limited-scope",
    selectionDigest: journal.selectionDigest,
    refs: journal.refs,
    receiptPath: prepared.receiptPath,
    report: formatPurgeSuccess(journal.refs, prepared.receiptPath),
  };
}

async function persistHistoryPurgePartialAndThrow(
  preflight: Preflight,
  prepared: PreparedHistoryPurgeEvidence,
  failedPhase: string,
  detail: string,
  now: Date,
): Promise<never> {
  const currentRefs = await Promise.all(prepared.journal.refs.map(async (ref) => ({
    name: ref.name,
    before: ref.before,
    after: await gitText(preflight.root, ["rev-parse", ref.name]).catch(() => "unknown"),
  })));
  const payload = {
    schemaVersion: 2,
    kind: "memory-fort-history-purge-partial",
    evidenceId: prepared.journal.evidenceId,
    operationId: prepared.journal.operationId,
    completedAt: now.toISOString(),
    status: "partial-local-history-rewrite",
    failedPhase,
    detail,
    refs: currentRefs,
    intendedRefs: prepared.journal.refs,
    operationEvidencePath: prepared.journalPath,
    limitations: [...LIMITATIONS],
    recovery: [
      "Do not force-push or run garbage collection.",
      "Preserve the signed prepared journal and backup/restore-drill evidence.",
      "Restore each scoped ref deliberately to either its prepared before or after tip before retrying.",
    ],
  };
  try {
    const partial = await persistVerifiedSignedEvidence(
      prepared.receiptPath,
      payload,
      prepared.signer,
      prepared.evidenceSecurityDir,
      "history purge partial receipt",
      prepared.write,
    );
    if (partial.kind !== "memory-fort-history-purge-partial"
      || partial.status !== "partial-local-history-rewrite") {
      throw new Error("history purge partial receipt read-back is invalid");
    }
  } catch (error) {
    throw await historyPurgePendingError(prepared, error);
  }
  throw new HistoryPurgePartialError(
    `memory forget --purge-history: refs are not safely finalized after ${failedPhase}; verified partial state and recovery guidance are at ${prepared.receiptPath}: ${detail}`,
    prepared.receiptPath,
  );
}

async function historyPurgePendingError(
  prepared: PreparedHistoryPurgeEvidence,
  error: unknown,
): Promise<HistoryPurgeEvidencePendingError> {
  const verified = await readPreparedHistoryPurgeJournal(
    prepared.journalPath,
    prepared.evidenceSecurityDir,
  );
  if (verified.operationId !== prepared.journal.operationId
    || verified.operationDigest !== prepared.journal.operationDigest) {
    throw new Error("memory forget --purge-history: prepared journal changed while final evidence was pending");
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new HistoryPurgeEvidencePendingError(
    prepared.journalPath,
    "rerun the same command with the identical confirmation to validate refs and finalize evidence",
    detail,
  );
}

async function resumePreflightFromJournal(
  opts: HistoryPurgeOptions,
  journal: HistoryPurgePreparedJournal,
  root: string,
): Promise<Preflight> {
  const now = opts.now ?? new Date();
  const liveReceipt = await readLiveEraseReceipt(journal.evidence.liveEraseReceiptPath, opts.evidenceSecurityDir);
  if (liveReceipt.evidenceId !== journal.evidence.liveEraseEvidenceId
    || liveReceipt.selection.digest !== journal.selectionDigest
    || !sameSelectors(liveReceipt.selection.selectors, journal.selectors)) {
    throw new Error("memory forget --purge-history: prepared journal live erase evidence no longer matches");
  }
  assertFreshEvidence("live erase receipt", liveReceipt.completedAt, now);
  const canonicalRoot = await realpath(memoryRoot());
  if (pathFingerprint(canonicalRoot) !== journal.canonicalRootFingerprint
    || pathFingerprint(canonicalRoot) !== liveReceipt.canonicalRootFingerprint) {
    throw new Error("memory forget --purge-history: prepared journal canonical root no longer matches");
  }
  await validateCurrentLiveEraseState(canonicalRoot, liveReceipt);
  const canonicalIdentity = await readRepositoryIdentity(canonicalRoot);
  if (!canonicalIdentity
    || !liveReceipt.repository
    || canonicalIdentity.head !== liveReceipt.repository.head
    || canonicalIdentity.commonGitDirFingerprint !== liveReceipt.repository.commonGitDirFingerprint) {
    throw new Error("memory forget --purge-history: canonical repository no longer matches prepared evidence");
  }

  const drillEvidence = await readRestoreDrillEvidence(
    journal.evidence.restoreDrillEvidencePath,
    opts.evidenceSecurityDir,
  );
  if (drillEvidence.evidenceId !== journal.evidence.restoreDrillEvidenceId) {
    throw new Error("memory forget --purge-history: prepared restore drill evidence no longer matches");
  }
  assertFreshEvidence("restore drill evidence", drillEvidence.completedAt, now);
  assertFreshEvidence("backup archive", drillEvidence.archive.createdAt, now);
  const verifiedBackup = await verifyBackup(drillEvidence.archive.path);
  if (verifiedBackup.archiveSha256 !== journal.evidence.backupArchiveSha256
    || verifiedBackup.manifestSha256 !== journal.evidence.backupManifestSha256) {
    throw new Error("memory forget --purge-history: prepared backup hashes no longer match");
  }

  const currentIdentity = await readRepositoryIdentity(root);
  if (!currentIdentity
    || currentIdentity.rootFingerprint !== journal.cloneIdentity.rootFingerprint
    || currentIdentity.commonGitDirFingerprint !== journal.cloneIdentity.commonGitDirFingerprint) {
    throw new Error("memory forget --purge-history: disposable clone identity no longer matches prepared journal");
  }
  await assertCleanRepository(root);
  await assertNoUnsafeGitOperation(root);
  validatePurgeTargets(journal.preflight.targets);
  return {
    root,
    identity: journal.cloneIdentity,
    canonicalRoot,
    liveReceipt,
    drillEvidence,
    selectors: cloneSelectors(journal.selectors),
    refs: journal.refs.map(({ name, before }) => ({ name, before })),
    currentRef: journal.currentRef,
    targets: journal.preflight.targets,
    remoteRefsDigest: journal.preflight.remoteRefsDigest,
    localConfigDigest: journal.preflight.localConfigDigest,
    additionalAffectedPaths: journal.preflight.additionalAffectedPaths,
    evidenceSecurityDir: opts.evidenceSecurityDir,
    protectedEvidence: journal.preflight.protectedEvidence,
    beforeObjects: journal.preflight.beforeObjects,
  };
}

async function readPreparedHistoryPurgeJournal(
  path: string,
  evidenceSecurityDir?: string,
): Promise<HistoryPurgePreparedJournal> {
  const value = await readVerifiedEvidenceFile(path, evidenceSecurityDir, "history purge prepared journal");
  if (!isHistoryPurgePreparedJournal(value)) {
    throw new Error("memory forget --purge-history: prepared journal schema is invalid");
  }
  return value;
}

function assertPreparedHistoryPurgeMatches(
  journal: HistoryPurgePreparedJournal,
  root: string,
  selectors: NormalizedForgetSelectors,
  opts: HistoryPurgeOptions,
  operationDigest: string,
): void {
  const requestedRefs = uniqueSorted(opts.refs);
  if (journal.operationDigest !== operationDigest
    || journal.cloneIdentity.rootFingerprint !== pathFingerprint(root)
    || !sameSelectors(journal.selectors, selectors)
    || JSON.stringify(uniqueSorted(journal.refs.map((ref) => ref.name))) !== JSON.stringify(requestedRefs)
    || journal.evidence.liveEraseReceiptPath !== resolve(opts.liveEraseReceiptPath)
    || journal.evidence.restoreDrillEvidencePath !== resolve(opts.restoreDrillEvidencePath)) {
    throw new Error("memory forget --purge-history: prepared journal does not match this exact command");
  }
}

function historyPurgeOperationDigest(
  root: string,
  selectors: NormalizedForgetSelectors,
  opts: HistoryPurgeOptions,
): string {
  return sha256Text(stableJson({
    kind: "memory-fort-history-purge-operation-v1",
    cloneRootFingerprint: pathFingerprint(root),
    selectors: cloneSelectors(selectors),
    refs: uniqueSorted(opts.refs),
    liveEraseReceiptPathFingerprint: pathFingerprint(resolve(opts.liveEraseReceiptPath)),
    restoreDrillEvidencePathFingerprint: pathFingerprint(resolve(opts.restoreDrillEvidencePath)),
  }));
}

function purgeValidationPlan(): string[] {
  return [
    "selected path and fingerprint absence across scoped history",
    "selected attribution absence from rewritten fact blobs",
    "scoped refs equal prepared after tips",
    "remote refs and local config digests unchanged",
    "backup and signed prerequisite evidence hashes unchanged",
    "clean worktree and git fsck --full --strict",
  ];
}

function isHistoryPurgePreparedJournal(value: unknown): value is HistoryPurgePreparedJournal {
  if (!isRecord(value)
    || value["schemaVersion"] !== 1
    || value["kind"] !== "memory-fort-history-purge-prepared"
    || value["status"] !== "prepared"
    || typeof value["evidenceId"] !== "string"
    || typeof value["operationId"] !== "string"
    || typeof value["preparedAt"] !== "string"
    || typeof value["operationDigest"] !== "string"
    || typeof value["evidenceKeyId"] !== "string"
    || typeof value["selectionDigest"] !== "string"
    || typeof value["canonicalRootFingerprint"] !== "string"
    || typeof value["currentRef"] !== "string"
    || !Array.isArray(value["refs"])
    || !value["refs"].every(isHistoryPurgeRefResult)
    || !isRecord(value["selectors"])
    || !isRecord(value["cloneIdentity"])
    || !isRecord(value["evidence"])
    || !isRecord(value["preflight"])
    || !isRecord(value["rewrite"])
    || !Array.isArray(value["validationPlan"])
    || !isRecord(value["recovery"])
    || !isRecord(value["auth"])) {
    return false;
  }
  return true;
}

function isHistoryPurgeRefResult(value: unknown): value is HistoryPurgeRefResult {
  return isRecord(value)
    && typeof value["name"] === "string"
    && typeof value["before"] === "string"
    && typeof value["after"] === "string";
}

function cloneSelectors(selectors: NormalizedForgetSelectors): NormalizedForgetSelectors {
  return {
    paths: [...selectors.paths],
    rawPaths: [...selectors.rawPaths],
    sourceIds: [...selectors.sourceIds],
  };
}
async function validateCurrentLiveEraseState(
  canonicalRoot: string,
  receipt: LiveEraseReceipt,
): Promise<void> {
  const generation = readIndexGeneration(canonicalRoot);
  if (generation.state !== "ready") {
    throw new Error("memory forget --purge-history: canonical live erase has pending index invalidation");
  }
  if (await readForgetRecovery(canonicalRoot)) {
    throw new Error("memory forget --purge-history: canonical live erase has pending recovery");
  }
  const removed = [
    ...receipt.selection.targets.raw,
    ...receipt.selection.targets.facts,
    ...receipt.selection.targets.generated,
  ];
  for (const relPath of removed) {
    if (existsSync(join(canonicalRoot, ...relPath.split("/")))) {
      throw new Error(`memory forget --purge-history: canonical live erase is incomplete for ${relPath}`);
    }
  }
  const selectedRaw = new Set(receipt.selection.targets.raw);
  for (const relPath of receipt.selection.targets.rewrittenFacts) {
    const path = join(canonicalRoot, ...relPath.split("/"));
    if (!existsSync(path)) {
      throw new Error(`memory forget --purge-history: canonical rewritten fact evidence is missing for ${relPath}`);
    }
    const parsed = parseFactJson(await readFile(path, "utf8"), relPath);
    if (rewriteSelectedFacts(parsed, selectedRaw).changed) {
      throw new Error(`memory forget --purge-history: canonical live erase still contains selected fact attribution in ${relPath}`);
    }
  }
}

async function readRestoreDrillEvidence(
  path: string,
  evidenceSecurityDir?: string,
): Promise<RestoreDrillEvidence> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`memory forget --purge-history: restore drill evidence is missing or invalid: ${detail}`);
  }
  await verifyEvidenceSignature(value, evidenceSecurityDir, "restore drill evidence");
  if (!isRecord(value)
    || value["schemaVersion"] !== 2
    || value["kind"] !== "memory-fort-restore-drill"
    || typeof value["evidenceId"] !== "string"
    || typeof value["completedAt"] !== "string"
    || !Number.isFinite(Date.parse(value["completedAt"]))
    || !isRecord(value["archive"])
    || typeof value["archive"]["path"] !== "string"
    || typeof value["archive"]["sha256"] !== "string"
    || typeof value["archive"]["manifestSha256"] !== "string"
    || typeof value["archive"]["createdAt"] !== "string"
    || !isRecord(value["repository"])
    || !(value["repository"]["head"] === null || typeof value["repository"]["head"] === "string")
    || !(value["repository"]["fingerprint"] === null || typeof value["repository"]["fingerprint"] === "string")
    || !(value["repository"]["refs"] === null || isRepositoryRefEvidence(value["repository"]["refs"]))
    || !isRecord(value["checks"])) {
    throw new Error("memory forget --purge-history: restore drill evidence is invalid");
  }
  const checks = value["checks"];
  const repository = value["repository"];
  const head = repository["head"] as string | null;
  const fingerprint = repository["fingerprint"] as string | null;
  const refs = repository["refs"];
  if (head === null
    ? fingerprint !== null || refs !== null
    : !isRepositoryRefEvidence(refs)
      || fingerprint !== repositoryFingerprint(head, refs)) {
    throw new Error("memory forget --purge-history: restore drill repository evidence is invalid");
  }

  if (value["status"] !== "passed"
    || checks["archiveVerified"] !== true
    || checks["gitVerified"] !== true
    || checks["indexRebuilt"] !== true
    || checks["canaryMatched"] !== true
    || checks["workspaceRemoved"] !== true) {
    throw new Error("memory forget --purge-history: restore drill evidence does not prove a passed clean backup and restore drill");
  }
  return value as unknown as RestoreDrillEvidence;
}

function assertFreshEvidence(label: string, completedAt: string, now: Date): void {
  const completedMs = Date.parse(completedAt);
  const ageMs = now.getTime() - completedMs;
  if (!Number.isFinite(completedMs)) {
    throw new Error(`memory forget --purge-history: ${label} timestamp is invalid`);
  }
  if (ageMs < -EVIDENCE_FUTURE_TOLERANCE_MS) {
    throw new Error(`memory forget --purge-history: ${label} timestamp is in the future`);
  }
  if (ageMs > EVIDENCE_FRESHNESS_MS) {
    throw new Error(`memory forget --purge-history: ${label} is stale; create fresh evidence within 24 hours`);
  }
}

async function assertCleanRepository(root: string): Promise<void> {
  const status = await gitText(root, ["status", "--porcelain=v2", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new Error("memory forget --purge-history: working tree and index must be clean");
  }
}

async function assertNoUnsafeGitOperation(root: string): Promise<void> {
  const unsafe = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ];
  const gitDir = await absoluteGitDir(root);
  for (const name of unsafe) {
    if (existsSync(join(gitDir, name))) {
      throw new Error(`memory forget --purge-history: unsafe Git operation is in progress: ${name}`);
    }
  }
}

function assertRepositoryRefBindings(
  current: RepositoryIdentity["refs"],
  live: RepositoryIdentity["refs"],
  drill: RepositoryIdentity["refs"],
): void {
  const names = uniqueSorted([
    ...Object.keys(current.heads),
    ...Object.keys(live.heads),
    ...Object.keys(drill.heads),
  ]);
  for (const name of names) {
    if (current.heads[name] !== live.heads[name]
      || current.heads[name] !== drill.heads[name]) {
      throw new Error(`memory forget --purge-history: ${name} does not match both signed evidence records`);
    }
  }
}

async function resolveScopedRefs(root: string, requested: readonly string[]): Promise<RefBefore[]> {
  if (requested.length === 0) {
    throw new Error("memory forget --purge-history: itemize at least one local refs/heads/... ref");
  }
  const seen = new Set<string>();
  const refs: RefBefore[] = [];
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!/^refs\/heads\/[^\s~^:?*\\[\]]+$/u.test(name) || name.includes("..") || name.endsWith("/")) {
      throw new Error(`memory forget --purge-history: only explicit local refs/heads/... refs are allowed, got ${name}`);
    }
    const before = await gitText(root, ["show-ref", "--verify", "--hash", name]).catch(() => "");
    if (!/^[0-9a-f]{40,64}$/u.test(before)) {
      throw new Error(`memory forget --purge-history: scoped ref does not exist: ${name}`);
    }
    const commit = await gitText(root, ["rev-parse", "--verify", `${name}^{commit}`]).catch(() => "");
    if (commit !== before) {
      throw new Error(`memory forget --purge-history: scoped ref must point directly to a commit: ${name}`);
    }
    refs.push({ name, before });
  }
  return refs;
}

async function currentBranchRef(root: string): Promise<string> {
  const ref = await gitText(root, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "");
  if (!ref.startsWith("refs/heads/")) {
    throw new Error("memory forget --purge-history: detached HEAD is not allowed");
  }
  return ref;
}

function purgeTargets(receipt: LiveEraseReceipt): PurgeTargets {
  const archivedFacts = receipt.selection.targets.retainedArchives.filter(isFactJsonPath);
  const fullDelete = uniqueSorted([
    ...receipt.selection.targets.raw,
    ...receipt.selection.targets.facts,
    ...receipt.selection.targets.generated,
    ...receipt.selection.targets.retainedArchives.filter((path) => !isFactJsonPath(path)),
  ]);
  const factRewrite = uniqueSorted([
    ...receipt.selection.targets.rewrittenFacts,
    ...archivedFacts,
  ]);
  return {
    fullDelete,
    factRewrite,
    all: uniqueSorted([...fullDelete, ...factRewrite]),
  };
}

function validatePurgeTargets(targets: PurgeTargets): void {
  if (targets.all.length === 0) {
    throw new Error("memory forget --purge-history: live erase receipt has no historical targets");
  }
  for (const path of targets.all) {
    if (!isCanonicalRelPath(path)
      || path === ".git"
      || path.startsWith(".git/")
      || path === "backups"
      || path.startsWith("backups/")
      || path === ".backups"
      || path.startsWith(".backups/")
      || path === "crystals"
      || path.startsWith("crystals/")
      || path === "var"
      || path.startsWith("var/")) {
      throw new Error(`memory forget --purge-history: unsafe historical target in receipt: ${path}`);
    }
  }
}

async function scanHistoryFingerprintMatches(
  root: string,
  refs: readonly string[],
  fingerprints: ContentFingerprintEvidence,
): Promise<string[]> {
  const commits = splitLines(await gitText(root, [
    "rev-list",
    "--reverse",
    "--topo-order",
    ...refs,
  ]));
  const trees = new Set<string>();
  for (const commit of commits) {
    trees.add(await gitText(root, ["show", "-s", "--format=%T", commit]));
  }
  const blobMatches = new Map<string, boolean>();
  const paths = new Set<string>();
  for (const tree of trees) {
    for (const entry of await listTreeEntries(root, tree)) {
      if (entry.type !== "blob") continue;
      let matched = blobMatches.get(entry.objectId);
      if (matched === undefined) {
        matched = hasSelectedContentFingerprint(
          await gitBuffer(root, ["cat-file", "blob", entry.objectId]),
          fingerprints,
        );
        blobMatches.set(entry.objectId, matched);
      }
      if (matched) paths.add(entry.path);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function listTreeEntries(root: string, tree: string): Promise<TreeEntry[]> {
  const output = await gitBuffer(root, ["ls-tree", "-r", "-z", tree]);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(0, offset);
    if (end < 0) throw new Error("memory forget --purge-history: malformed Git tree listing");
    const bytes = output.subarray(offset, end);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) {
      throw new Error("memory forget --purge-history: Git tree contains a non-UTF-8 path");
    }
    const tab = value.indexOf("\t");
    if (tab < 0) throw new Error("memory forget --purge-history: malformed Git tree entry");
    const header = value.slice(0, tab).split(" ");
    const path = value.slice(tab + 1);
    if (header.length !== 3
      || !/^[0-7]{6}$/u.test(header[0]!)
      || (header[1] !== "blob" && header[1] !== "commit")
      || !/^[0-9a-f]{40,64}$/u.test(header[2]!)
      || !isCanonicalRelPath(path)) {
      throw new Error("memory forget --purge-history: unsafe or malformed Git tree entry");
    }
    entries.push({
      mode: header[0]!,
      type: header[1] as "blob" | "commit",
      objectId: header[2]!,
      path,
    });
    offset = end + 1;
  }
  return entries;
}

async function writeTreeBlob(
  root: string,
  env: NodeJS.ProcessEnv,
  entry: TreeEntry,
  body: Buffer,
): Promise<void> {
  const objectId = (await gitBuffer(root, ["hash-object", "-w", "--stdin"], { input: body }))
    .toString("utf8")
    .trim();
  if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw new Error("memory forget --purge-history: Git returned an invalid rewritten blob ID");
  }
  await gitBuffer(root, [
    "update-index", "--add", "--cacheinfo", entry.mode, objectId, entry.path,
  ], { env });
}

async function rewriteTree(
  root: string,
  originalTree: string,
  indexPath: string,
  targets: PurgeTargets,
  selectedRaw: Set<string>,
  fingerprints: ContentFingerprintEvidence,
): Promise<string> {
  await rm(indexPath, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  await gitBuffer(root, ["read-tree", originalTree], { env });
  const fullDelete = new Set(targets.fullDelete);
  const factRewrite = new Set(targets.factRewrite);
  for (const path of fullDelete) {
    await gitBuffer(root, ["update-index", "--force-remove", "--", path], { env });
  }

  for (const entry of await listTreeEntries(root, originalTree)) {
    if (entry.type !== "blob" || fullDelete.has(entry.path)) continue;
    const original = await gitBuffer(root, ["cat-file", "blob", entry.objectId]);
    let body = original;
    let changed = false;

    if (factRewrite.has(entry.path)) {
      const parsed = parseFactJson(body.toString("utf8"), entry.path);
      const rewritten = rewriteSelectedFacts(parsed, selectedRaw);
      if (rewritten.changed) {
        if (rewritten.empty) {
          await gitBuffer(root, ["update-index", "--force-remove", "--", entry.path], { env });
          continue;
        }
        body = Buffer.from(`${JSON.stringify(rewritten.value, null, 2)}\n`, "utf8");
        changed = true;
      }
    }

    const scrubbed = scrubSelectedContentFingerprints(body, fingerprints);
    if (scrubbed.matched) {
      if (scrubbed.content === null) {
        await gitBuffer(root, ["update-index", "--force-remove", "--", entry.path], { env });
        continue;
      }
      body = scrubbed.content;
      changed = true;
    }
    if (changed) await writeTreeBlob(root, env, entry, body);
  }
  return (await gitBuffer(root, ["write-tree"], { env })).toString("utf8").trim();
}

async function readTreeEntry(
  root: string,
  tree: string,
  path: string,
): Promise<{ mode: string; objectId: string } | null> {
  const output = await gitBuffer(root, ["ls-tree", "-z", tree, "--", path]);
  if (output.length === 0) return null;
  const first = output.subarray(0, output.indexOf(0) >= 0 ? output.indexOf(0) : output.length).toString("utf8");
  const match = /^([0-7]{6})\s+blob\s+([0-9a-f]{40,64})\t/u.exec(first);
  if (!match) {
    throw new Error(`memory forget --purge-history: historical fact target is not a regular blob: ${path}`);
  }
  return { mode: match[1]!, objectId: match[2]! };
}

function parseCommit(content: Buffer): ParsedCommit {
  const separator = content.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new Error("memory forget --purge-history: malformed commit object");
  const header = content.subarray(0, separator).toString("utf8");
  const lines = header.split("\n");
  const tree = lines.find((line) => line.startsWith("tree "))?.slice(5);
  const authorLine = lines.find((line) => line.startsWith("author "))?.slice(7);
  const committerLine = lines.find((line) => line.startsWith("committer "))?.slice(10);
  if (!tree || !authorLine || !committerLine) {
    throw new Error("memory forget --purge-history: commit metadata is incomplete");
  }
  return {
    tree,
    parents: lines.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7)),
    author: parseGitIdentity(authorLine),
    committer: parseGitIdentity(committerLine),
    message: content.subarray(separator + 2),
    signed: lines.some((line) => line.startsWith("gpgsig ")),
  };
}

function parseGitIdentity(value: string): GitIdentity {
  const match = /^(.*) <([^<>]*)> (\d+ [+-]\d{4})$/u.exec(value);
  if (!match) throw new Error("memory forget --purge-history: commit identity metadata is invalid");
  return { name: match[1]!, email: match[2]!, date: match[3]! };
}

async function writeCommit(
  root: string,
  tree: string,
  parents: readonly string[],
  commit: ParsedCommit,
): Promise<string> {
  const args = [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
  ];
  const output = await gitBuffer(root, args, {
    input: commit.message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: commit.author.name,
      GIT_AUTHOR_EMAIL: commit.author.email,
      GIT_AUTHOR_DATE: commit.author.date,
      GIT_COMMITTER_NAME: commit.committer.name,
      GIT_COMMITTER_EMAIL: commit.committer.email,
      GIT_COMMITTER_DATE: commit.committer.date,
    },
  });
  const objectId = output.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw new Error("memory forget --purge-history: git commit-tree returned an invalid object ID");
  }
  return objectId;
}

async function updateRefsAtomically(
  root: string,
  refs: readonly HistoryPurgeRefResult[],
): Promise<void> {
  const transaction = [
    "start",
    ...refs.map((ref) => `update ${ref.name} ${ref.after} ${ref.before}`),
    "prepare",
    "commit",
    "",
  ].join("\n");
  await gitBuffer(root, ["update-ref", "--stdin"], { input: transaction });
}

async function validateRewrite(
  preflight: Preflight,
  refs: readonly HistoryPurgeRefResult[],
): Promise<Array<{ command: string; result: "passed" }>> {
  const refNames = refs.map((ref) => ref.name);
  await assertCleanRepository(preflight.root);
  const remainingFingerprintPaths = await scanHistoryFingerprintMatches(
    preflight.root,
    refNames,
    preflight.liveReceipt.selection.contentFingerprints,
  );
  if (remainingFingerprintPaths.length > 0) {
    throw new Error(`memory forget --purge-history: selected content fingerprints remain in rewritten history: ${remainingFingerprintPaths.join(", ")}`);
  }
  for (const target of preflight.targets.fullDelete) {
    const history = await gitText(preflight.root, ["rev-list", ...refNames, "--", target]);
    if (history.length > 0) {
      throw new Error(`memory forget --purge-history: selected path remains in rewritten history: ${target}`);
    }
    if (existsSync(join(preflight.root, ...target.split("/")))) {
      throw new Error(`memory forget --purge-history: selected path remains in the rewritten live tree: ${target}`);
    }
  }
  const selectedRaw = new Set(preflight.liveReceipt.selection.targets.raw);
  const commits = splitLines(await gitText(preflight.root, [
    "rev-list",
    "--reverse",
    "--topo-order",
    ...refNames,
  ]));
  for (const commit of commits) {
    const tree = (await gitText(preflight.root, ["show", "-s", "--format=%T", commit])).trim();
    for (const target of preflight.targets.factRewrite) {
      const entry = await readTreeEntry(preflight.root, tree, target);
      if (!entry) continue;
      const parsed = parseFactJson(
        (await gitBuffer(preflight.root, ["cat-file", "blob", entry.objectId])).toString("utf8"),
        target,
      );
      if (rewriteSelectedFacts(parsed, selectedRaw).changed) {
        throw new Error(`memory forget --purge-history: selected fact attribution remains in rewritten history: ${target}`);
      }
    }
  }
  for (const target of preflight.targets.factRewrite) {
    const path = join(preflight.root, ...target.split("/"));
    if (!existsSync(path)) continue;
    const parsed = parseFactJson(await readFile(path, "utf8"), target);
    if (rewriteSelectedFacts(parsed, selectedRaw).changed) {
      throw new Error(`memory forget --purge-history: selected fact attribution remains in rewritten live tree: ${target}`);
    }
  }
  for (const ref of refs) {
    if (await gitText(preflight.root, ["rev-parse", ref.name]) !== ref.after) {
      throw new Error(`memory forget --purge-history: rewritten ref validation failed: ${ref.name}`);
    }
  }
  if (sha256Text(await gitText(preflight.root, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/remotes",
  ])) !== preflight.remoteRefsDigest) {
    throw new Error("memory forget --purge-history: a remote-tracking ref changed unexpectedly");
  }
  if (sha256Text(await gitText(preflight.root, ["config", "--local", "--null", "--list"]))
    !== preflight.localConfigDigest) {
    throw new Error("memory forget --purge-history: local remote/config state changed unexpectedly");
  }
  for (const evidence of preflight.protectedEvidence) {
    const after = await snapshotFile(evidence.path, "protected evidence");
    if (after.sha256 !== evidence.sha256 || after.size !== evidence.size) {
      throw new Error("memory forget --purge-history: backup or evidence file changed unexpectedly");
    }
  }
  await assertCleanRepository(preflight.root);
  await gitBuffer(preflight.root, ["fsck", "--full", "--strict"]);
  return [
    { command: "git rev-list <scoped refs> -- <selected full-delete paths>", result: "passed" },
    { command: "git cat-file <rewritten fact blobs>; selected attribution scan", result: "passed" },
    { command: "all reachable blobs and clean HEAD/live tree; selected fingerprint scan", result: "passed" },
    { command: "working-tree selected path and attribution scan", result: "passed" },
    { command: "git for-each-ref refs/remotes; before/after digest comparison", result: "passed" },
    { command: "backup archive and evidence SHA-256 comparison", result: "passed" },
    { command: "git fsck --full --strict", result: "passed" },
  ];
}

function rewriteSelectedFacts(
  value: unknown,
  selectedRaw: Set<string>,
): { value: unknown; changed: boolean; empty: boolean } {
  if (Array.isArray(value)) {
    const next = value.filter((fact) => !factMatchesSelectedRaw(fact, selectedRaw));
    return { value: next, changed: next.length !== value.length, empty: next.length === 0 };
  }
  if (!isRecord(value)) return { value, changed: false, empty: false };
  const facts = Array.isArray(value["facts"]) ? value["facts"] : [];
  const next = facts.filter((fact) => !factMatchesSelectedRaw(fact, selectedRaw));
  const rootRaw = rawPathFromRecord(value);
  const rootMatches = rootRaw !== null && selectedRaw.has(rootRaw);
  const changed = rootMatches || next.length !== facts.length;
  return {
    value: { ...value, ...(Array.isArray(value["facts"]) ? { facts: next } : {}) },
    changed,
    empty: changed && (rootMatches || (Array.isArray(value["facts"]) && next.length === 0)),
  };
}

function factMatchesSelectedRaw(value: unknown, selectedRaw: Set<string>): boolean {
  const rawPath = rawPathFromRecord(value);
  return rawPath !== null && selectedRaw.has(rawPath);
}

function rawPathFromRecord(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value["sourceRawPath"] === "string"
    ? value["sourceRawPath"].replace(/\\/gu, "/")
    : null;
}

function parseFactJson(content: string, path: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`memory forget --purge-history: historical fact target is not valid JSON: ${path}`);
  }
}

async function targetObjectEvidence(
  root: string,
  refs: readonly string[],
  paths: readonly string[],
): Promise<ObjectEvidence> {
  const output = paths.length === 0
    ? ""
    : await gitText(root, ["rev-list", "--objects", ...refs, "--", ...paths]);
  const objectIds = uniqueSorted(
    splitLines(output)
      .map((line) => line.split(" ", 1)[0]!)
      .filter((value) => /^[0-9a-f]{40,64}$/u.test(value)),
  );
  return {
    count: objectIds.length,
    digest: sha256Text(objectIds.join("\n")),
  };
}

async function snapshotFile(path: string, label: string): Promise<FileEvidence> {
  const resolved = resolve(path);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`memory forget --purge-history: ${label} is missing`);
  }
  const hash = createHash("sha256").update(await readFile(resolved)).digest("hex");
  return { path: resolved, sha256: hash, size: info.size };
}

async function absoluteGitDir(root: string): Promise<string> {
  return realpath(await gitText(root, ["rev-parse", "--absolute-git-dir"]));
}


function formatPurgePlan(preflight: Preflight): string {
  const lines = [
    "Memory forget purge-history plan",
    "No history was rewritten.",
    "This workflow rewrites only the itemized local branch refs in this disposable clone.",
    "",
    `Selection digest: ${preflight.liveReceipt.selection.digest}`,
    "Historical targets to remove:",
    ...preflight.targets.fullDelete.map((path) => `- ${path}`),
    "",
    "Historical fact paths to redact:",
    ...(preflight.targets.factRewrite.length > 0
      ? preflight.targets.factRewrite.map((path) => `- ${path}`)
      : ["- (none)"]),
    "",
    "Additional paths containing selected content fingerprints:",
    ...(preflight.additionalAffectedPaths.length > 0
      ? preflight.additionalAffectedPaths.map((path) => `- ${path}`)
      : ["- (none)"]),
    "",
    "Local refs to rewrite:",
    ...preflight.refs.map((ref) => `- ${ref.name}`),
    "",
    "Not purged:",
    ...LIMITATIONS.map((limitation) => `- ${limitation}`),
    "",
    `Required confirmation: ${PURGE_HISTORY_CONFIRMATION}`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatPurgeSuccess(
  refs: readonly HistoryPurgeRefResult[],
  receiptPath: string,
): string {
  return [
    "Memory forget purge-history complete",
    "Status: purged-local-history/limited-scope",
    "Rewritten local refs:",
    ...refs.map((ref) => `- ${ref.name}: ${ref.before} -> ${ref.after}`),
    "",
    "Remote publication, other clones, reflogs, unreachable objects, and backups remain manual.",
    `Durable redacted receipt: ${receiptPath}`,
    "",
  ].join("\n");
}

function sameSelectors(
  left: NormalizedForgetSelectors,
  right: NormalizedForgetSelectors,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
}

function isFactJsonPath(path: string): boolean {
  return path.startsWith("facts/") && path.toLowerCase().endsWith(".json");
}

function isCanonicalRelPath(path: string): boolean {
  return path.length > 0
    && path === path.trim()
    && !path.includes("\\")
    && !path.startsWith("/")
    && !/^[A-Za-z]:/u.test(path)
    && !path.includes("//")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function gitText(
  root: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<string> {
  return (await gitBuffer(root, args, opts)).toString("utf8").trim();
}

async function gitBuffer(
  root: string,
  args: readonly string[],
  opts: GitRunOptions = {},
): Promise<Buffer> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", root, ...args], {
      env: opts.env ?? process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectRun(error);
    };
    child.on("error", (error) => fail(error));
    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > GIT_OUTPUT_LIMIT_BYTES) {
        fail(new Error("memory forget --purge-history: Git output exceeded the safety limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > GIT_OUTPUT_LIMIT_BYTES) {
        fail(new Error("memory forget --purge-history: Git output exceeded the safety limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        rejectRun(new Error(
          `memory forget --purge-history: Git ${args[0] ?? "command"} failed with exit code ${code ?? "unknown"}; output was redacted`,
        ));
        return;
      }
      resolveRun(Buffer.concat(stdout));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input);
  });
}
