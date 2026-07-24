import { execFile as nodeExecFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { Command } from "commander";

import { openIndexDb } from "../../index/db.js";
import { reconcileIndex } from "../../index/reconcile.js";
import { InlineSearchExecutor } from "../../index/vector-search.js";
import { memoryRoot } from "../../storage/paths.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import { repositoryFingerprint } from "../../forget/evidence.js";

const MANIFEST_NAME = "backup-manifest.json";
const BACKUP_SCHEMA_VERSION = 1;
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_COMMAND_BUFFER_BYTES = 256 * 1024 * 1024;
const CANARY_SAMPLE_BYTES = 256 * 1024;

const VAULT_RUNTIME_EXCLUSIONS = [
  "backups/",
  "errors.log",
  "auto-sync.log",
  "logs/",
  "var/",
  "embeddings/* except embeddings/auto-heal.jsonl",
  "raw/**/*.tmp",
  "**/*.*.lock",
  ".auto-push-pending.lock",
] as const;

export type BackupProtectionClass = "local-same-device" | "local-different-device";
export type BackupGitMode = "worktree" | "bare";
export type BackupComponent = "vault" | "repository";

export interface BackupManifestEntry {
  readonly component: BackupComponent;
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly kind: "memory-fort-backup";
  readonly createdAt: string;
  readonly protection: {
    readonly class: BackupProtectionClass;
    readonly offHostVerified: false;
    readonly basis: "filesystem-device-id";
  };
  readonly vault: {
    readonly archiveRoot: string;
  };
  readonly git: {
    readonly mode: BackupGitMode;
    readonly archiveRoot: string;
    readonly head: string | null;
    readonly verification: "git-fsck-full-strict";
  };
  readonly canary: {
    readonly query: string;
    readonly expectedPath: string;
  };
  readonly exclusions: readonly string[];
  readonly summary: {
    readonly fileCount: number;
    readonly totalBytes: number;
  };
  readonly restore: {
    readonly policy: "extract-to-new-directory-only";
    readonly instructions: readonly string[];
  };
  readonly entries: readonly BackupManifestEntry[];
}

export interface BackupCreateOptions {
  readonly vaultRoot?: string;
  readonly repositoryRoot?: string;
  readonly targetDir: string;
  readonly now?: Date;
  readonly tempRoot?: string;
  readonly execFile?: ExecFile;
}

export interface BackupVerifyOptions {
  readonly tempRoot?: string;
  readonly execFile?: ExecFile;
}

export interface RestoreDrillOptions extends BackupVerifyOptions {
  readonly now?: Date;
}

export interface BackupVerificationResult {
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly manifestSha256: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly protectionClass: BackupProtectionClass;
  readonly offHostVerified: false;
  readonly gitMode: BackupGitMode;
  readonly gitHead: string | null;
  readonly gitVerified: true;
}

export interface BackupCreateResult extends BackupVerificationResult {
  readonly verified: true;
}

export interface RestoreDrillResult extends BackupVerificationResult {
  readonly indexRebuilt: true;
  readonly indexedFiles: number;
  readonly canaryQuery: string;
  readonly expectedPath: string;
  readonly matchedPath: string;
  readonly canaryMatched: true;
  readonly workspaceRemoved: true;
  readonly durationMs: number;
  readonly evidenceId: string;
  readonly evidencePath: string;
  readonly completedAt: string;
  readonly repositoryFingerprint: string | null;
}

export interface RestoreDrillEvidence {
  readonly schemaVersion: 1;
  readonly kind: "memory-fort-restore-drill";
  readonly evidenceId: string;
  readonly completedAt: string;
  readonly status: "passed";
  readonly archive: {
    readonly path: string;
    readonly sha256: string;
    readonly manifestSha256: string;
    readonly createdAt: string;
  };
  readonly repository: {
    readonly head: string | null;
    readonly fingerprint: string | null;
  };
  readonly checks: {
    readonly archiveVerified: true;
    readonly gitVerified: true;
    readonly indexRebuilt: true;
    readonly canaryMatched: true;
    readonly workspaceRemoved: true;
  };
}

interface ExecFileOptions {
  readonly cwd?: string;
  readonly timeout?: number;
  readonly windowsHide?: boolean;
  readonly maxBuffer?: number;
  readonly encoding?: "utf8";
}

type ExecFile = (
  command: string,
  args: string[],
  options?: ExecFileOptions,
) => Promise<{ stdout?: string; stderr?: string }>;

interface SourceComponent {
  readonly role: BackupComponent;
  readonly sourceRoot: string;
  readonly archiveRoot: string;
}

interface ScannedEntry extends BackupManifestEntry {
  readonly absPath: string;
  readonly vaultRelativePath?: string;
}

interface GitSource {
  readonly mode: BackupGitMode;
  readonly sourceRoot: string;
  readonly archiveRoot: string;
}

interface VerifiedExtraction {
  readonly manifest: BackupManifest;
  readonly verification: BackupVerificationResult;
  readonly extractionRoot: string;
  readonly vaultRoot: string;
}

const execFileAsync = promisify(nodeExecFile) as ExecFile;

export async function createBackup(opts: BackupCreateOptions): Promise<BackupCreateResult> {
  const run = opts.execFile ?? execFileAsync;
  const now = opts.now ?? new Date();
  const vaultRoot = await resolveExistingDirectory(opts.vaultRoot ?? memoryRoot(), "vault");
  const targetDir = await resolveTargetDirectory(opts.targetDir);
  assertTargetOutsideSource(vaultRoot, targetDir, "vault");

  const gitSource = await resolveGitSource(vaultRoot, opts.repositoryRoot, run);
  if (gitSource.sourceRoot !== vaultRoot) {
    assertNonOverlappingSources(vaultRoot, gitSource.sourceRoot);
    assertTargetOutsideSource(gitSource.sourceRoot, targetDir, "repository");
  }

  await runStrictGitFsck(gitSource, run);
  const gitHead = await readGitHead(gitSource, run);
  const protectionClass = classifyProtectionClass((await stat(vaultRoot)).dev, (await stat(targetDir)).dev);
  const components: SourceComponent[] = [
    { role: "vault", sourceRoot: vaultRoot, archiveRoot: archiveRootFor(vaultRoot, "vault") },
  ];
  if (gitSource.sourceRoot !== vaultRoot) {
    components.push({
      role: "repository",
      sourceRoot: gitSource.sourceRoot,
      archiveRoot: archiveRootFor(gitSource.sourceRoot, "repository"),
    });
  }
  assertDistinctArchiveRoots(components);

  const entries = (
    await Promise.all(components.map((component) => scanComponent(component)))
  ).flat().sort((left, right) => compareText(left.path, right.path));
  if (entries.length === 0) throw new Error("backup source contains no durable files");
  const canary = await selectRestoreCanary(entries);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind: "memory-fort-backup",
    createdAt: now.toISOString(),
    protection: {
      class: protectionClass,
      offHostVerified: false,
      basis: "filesystem-device-id",
    },
    vault: { archiveRoot: components[0]!.archiveRoot },
    git: {
      mode: gitSource.mode,
      archiveRoot: gitSource.archiveRoot,
      head: gitHead,
      verification: "git-fsck-full-strict",
    },
    canary,
    exclusions: [...VAULT_RUNTIME_EXCLUSIONS],
    summary: { fileCount: entries.length, totalBytes },
    restore: {
      policy: "extract-to-new-directory-only",
      instructions: [
        "Run `memory backup verify <archive>` before attempting recovery.",
        "Run `memory backup drill <archive>` to prove extraction, Git integrity, index rebuild, and canary search.",
        "For a live recovery, extract into a new empty directory; never overwrite the active vault in place.",
      ],
    },
    entries: entries.map(({ component, path, sizeBytes, sha256 }) => ({ component, path, sizeBytes, sha256 })),
  };
  validateManifest(manifest);

  const operationRoot = await makeOperationRoot(opts.tempRoot ?? targetDir, "memory-backup-create-");
  const finalArchive = join(targetDir, archiveFileName(now));
  if (await lstat(finalArchive).then(() => true).catch(() => false)) {
    await rm(operationRoot, { force: true, recursive: true });
    throw new Error(`backup archive already exists: ${finalArchive}`);
  }
  const partialArchive = `${finalArchive}.partial-${process.pid}-${randomUUID()}`;
  try {
    const stagingRoot = join(operationRoot, "staging");
    await mkdir(stagingRoot, { recursive: true });
    for (const component of components) {
      await stageComponentDirectories(component, stagingRoot);
    }
    for (const entry of entries) {
      const stagedPath = safeJoin(stagingRoot, entry.path);
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(entry.absPath, stagedPath);
      const stagedHash = await sha256File(stagedPath);
      if (stagedHash !== entry.sha256) {
        throw new Error(`source changed while staging backup: ${entry.path}`);
      }
    }
    const manifestPath = join(stagingRoot, MANIFEST_NAME);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await run("tar", ["-czf", partialArchive, "-C", stagingRoot, "."], commandOptions());

    const verification = await verifyBackup(partialArchive, {
      execFile: run,
      tempRoot: opts.tempRoot ?? targetDir,
    });
    await rename(partialArchive, finalArchive);
    return {
      ...verification,
      archivePath: finalArchive,
      verified: true,
    };
  } finally {
    await rm(partialArchive, { force: true }).catch(() => undefined);
    await rm(operationRoot, { force: true, recursive: true });
  }
}

export async function verifyBackup(
  archivePath: string,
  opts: BackupVerifyOptions = {},
): Promise<BackupVerificationResult> {
  const used = await useVerifiedBackup(archivePath, opts, async () => undefined);
  return used.verification;
}

export async function runRestoreDrill(
  archivePath: string,
  opts: RestoreDrillOptions = {},
): Promise<RestoreDrillResult> {
  const started = Date.now();
  const used = await useVerifiedBackup(archivePath, opts, async ({ manifest, extractionRoot, vaultRoot }) => {
    const indexDb = openIndexDb(join(extractionRoot, ".restore-drill", "index.db"));
    try {
      const reconciliation = await reconcileIndex(indexDb, vaultRoot);
      indexDb.integrityCheck();
      const executor = new InlineSearchExecutor({ indexDb, embedder: null });
      const response = await executor.search({ query: manifest.canary.query, limit: 100 });
      const match = response.results.find((result) => normalizeArchivePath(result.path) === manifest.canary.expectedPath);
      if (!match) {
        throw new Error(
          `restore drill canary search did not find ${manifest.canary.expectedPath} for query ${JSON.stringify(manifest.canary.query)}`,
        );
      }
      return {
        indexedFiles: reconciliation.filesIndexed,
        matchedPath: normalizeArchivePath(match.path),
      };
    } finally {
      indexDb.close();
    }
  });

  const completedAt = (opts.now ?? new Date()).toISOString();
  const evidenceId = randomUUID();
  const repositoryFingerprintValue = used.verification.gitHead
    ? repositoryFingerprint(used.verification.gitHead)
    : null;
  const evidenceStamp = completedAt.replace(/[:.]/gu, "-");
  const evidencePath = `${used.verification.archivePath}.restore-drill-${evidenceStamp}-${evidenceId}.json`;
  const result: RestoreDrillResult = {
    ...used.verification,
    indexRebuilt: true,
    indexedFiles: used.value.indexedFiles,
    canaryQuery: used.manifest.canary.query,
    expectedPath: used.manifest.canary.expectedPath,
    matchedPath: used.value.matchedPath,
    canaryMatched: true,
    workspaceRemoved: true,
    durationMs: Date.now() - started,
    evidenceId,
    evidencePath,
    completedAt,
    repositoryFingerprint: repositoryFingerprintValue,
  };
  const evidence: RestoreDrillEvidence = {
    schemaVersion: 1,
    kind: "memory-fort-restore-drill",
    evidenceId,
    completedAt,
    status: "passed",
    archive: {
      path: used.verification.archivePath,
      sha256: used.verification.archiveSha256,
      manifestSha256: used.verification.manifestSha256,
      createdAt: used.verification.createdAt,
    },
    repository: {
      head: used.verification.gitHead,
      fingerprint: repositoryFingerprintValue,
    },
    checks: {
      archiveVerified: true,
      gitVerified: true,
      indexRebuilt: true,
      canaryMatched: true,
      workspaceRemoved: true,
    },
  };
  await atomicWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return result;
}

export function classifyProtectionClass(sourceDevice: number, targetDevice: number): BackupProtectionClass {
  return sourceDevice === targetDevice ? "local-same-device" : "local-different-device";
}

export function formatBackupCreateResult(result: BackupCreateResult): string {
  return [
    `Backup created and verified: ${result.archivePath}`,
    `Files: ${result.fileCount}; bytes: ${result.totalBytes}`,
    `Manifest SHA-256: ${result.manifestSha256}`,
    `Archive SHA-256: ${result.archiveSha256}`,
    `Protection: ${result.protectionClass}; off-host durability is not attested by this command`,
    "Next proof: memory backup drill <archive>",
    "",
  ].join("\n");
}

export function formatBackupVerifyResult(result: BackupVerificationResult): string {
  return [
    `Backup verified: ${result.archivePath}`,
    `Files: ${result.fileCount}; bytes: ${result.totalBytes}`,
    `Git: ${result.gitMode} strict full-object fsck passed`,
    `Manifest SHA-256: ${result.manifestSha256}`,
    `Archive SHA-256: ${result.archiveSha256}`,
    "",
  ].join("\n");
}

export function formatRestoreDrillResult(result: RestoreDrillResult): string {
  return [
    `Restore drill passed: ${result.archivePath}`,
    `Git verified: yes; index rebuilt: yes (${result.indexedFiles} files indexed)`,
    `Canary matched: ${result.matchedPath}`,
    `Disposable workspace removed: yes; duration: ${result.durationMs} ms`,
    `Machine-readable drill evidence: ${result.evidencePath}`,
    "",
  ].join("\n");
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command("backup")
    .description("Create, verify, and drill cryptographically manifested memory backups");

  backup
    .command("create")
    .description("Create an atomic archive and verify it by extraction, hashing, and strict Git fsck")
    .requiredOption("--target <directory>", "backup destination; must be outside the vault")
    .option("--vault <path>", "vault root (default: ~/.memory)")
    .option("--repository <path>", "adjacent bare Git repository for VPS-style vaults")
    .option("--json", "emit structured JSON")
    .action(async (opts: { target: string; vault?: string; repository?: string; json?: boolean }) => {
      try {
        const result = await createBackup({
          targetDir: opts.target,
          vaultRoot: opts.vault,
          repositoryRoot: opts.repository,
        });
        process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatBackupCreateResult(result));
      } catch (error) {
        process.stderr.write(`memory backup create failed: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });

  backup
    .command("verify <archive>")
    .description("Extract an archive and verify its manifest, every file hash, and Git object integrity")
    .option("--json", "emit structured JSON")
    .action(async (archive: string, opts: { json?: boolean }) => {
      try {
        const result = await verifyBackup(archive);
        process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatBackupVerifyResult(result));
      } catch (error) {
        process.stderr.write(`memory backup verify failed: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });

  backup
    .command("drill <archive>")
    .description("Restore into a disposable directory, rebuild the index, and run a known-content search")
    .option("--json", "emit structured JSON receipt")
    .action(async (archive: string, opts: { json?: boolean }) => {
      try {
        const result = await runRestoreDrill(archive);
        process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : formatRestoreDrillResult(result));
      } catch (error) {
        process.stderr.write(`memory backup drill failed: ${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    });
}

async function useVerifiedBackup<T>(
  archivePath: string,
  opts: BackupVerifyOptions,
  callback: (extraction: VerifiedExtraction) => Promise<T>,
): Promise<{
  verification: BackupVerificationResult;
  manifest: BackupManifest;
  value: T;
}> {
  const run = opts.execFile ?? execFileAsync;
  const resolvedArchive = resolve(archivePath);
  const archiveStats = await stat(resolvedArchive).catch(() => null);
  if (!archiveStats?.isFile() || archiveStats.size <= 0) {
    throw new Error(`backup archive is missing or empty: ${resolvedArchive}`);
  }

  const listing = await run("tar", ["-tzf", resolvedArchive], commandOptions());
  const listedFiles = validateArchiveListing(listing.stdout ?? "");
  const operationRoot = await makeOperationRoot(opts.tempRoot, "memory-backup-verify-");
  const extractionRoot = join(operationRoot, "extracted");
  await mkdir(extractionRoot, { recursive: true });
  try {
    await run("tar", ["-xzf", resolvedArchive, "-C", extractionRoot], commandOptions());
    const manifestBytes = await readFile(join(extractionRoot, MANIFEST_NAME));
    const manifest = parseManifest(manifestBytes.toString("utf8"));
    assertListingMatchesManifest(listedFiles, manifest);
    await verifyExtractedFiles(extractionRoot, manifest);

    const gitRoot = safeJoin(extractionRoot, manifest.git.archiveRoot);
    await runStrictGitFsck(
      { mode: manifest.git.mode, sourceRoot: gitRoot, archiveRoot: manifest.git.archiveRoot },
      run,
    );
    const restoredHead = await readGitHead(
      { mode: manifest.git.mode, sourceRoot: gitRoot, archiveRoot: manifest.git.archiveRoot },
      run,
    );
    if (restoredHead !== manifest.git.head) {
      throw new Error(`restored Git HEAD mismatch: expected ${String(manifest.git.head)}, got ${String(restoredHead)}`);
    }

    const verification: BackupVerificationResult = {
      archivePath: resolvedArchive,
      archiveSha256: await sha256File(resolvedArchive),
      manifestSha256: sha256Bytes(manifestBytes),
      createdAt: manifest.createdAt,
      fileCount: manifest.summary.fileCount,
      totalBytes: manifest.summary.totalBytes,
      protectionClass: manifest.protection.class,
      offHostVerified: false,
      gitMode: manifest.git.mode,
      gitHead: manifest.git.head,
      gitVerified: true,
    };
    const extraction: VerifiedExtraction = {
      manifest,
      verification,
      extractionRoot,
      vaultRoot: safeJoin(extractionRoot, manifest.vault.archiveRoot),
    };
    return { verification, manifest, value: await callback(extraction) };
  } finally {
    await rm(operationRoot, { force: true, recursive: true });
  }
}

async function resolveGitSource(vaultRoot: string, repositoryRoot: string | undefined, run: ExecFile): Promise<GitSource> {
  const dotGit = join(vaultRoot, ".git");
  const dotGitStats = await lstat(dotGit).catch(() => null);
  if (dotGitStats?.isDirectory()) {
    if (repositoryRoot) {
      throw new Error("--repository is not allowed when the vault already contains a self-contained .git directory");
    }
    return { mode: "worktree", sourceRoot: vaultRoot, archiveRoot: archiveRootFor(vaultRoot, "vault") };
  }
  if (dotGitStats && !dotGitStats.isFile()) {
    throw new Error("vault .git entry must be a directory or a regular gitdir pointer file");
  }
  if (!repositoryRoot) {
    throw new Error(
      "vault is not a self-contained Git worktree; pass --repository <bare-repository> for a VPS-style layout",
    );
  }

  const resolvedRepository = await resolveExistingDirectory(repositoryRoot, "repository");
  const probe = await run(
    "git",
    [`--git-dir=${resolvedRepository}`, "rev-parse", "--is-bare-repository"],
    commandOptions(),
  );
  if ((probe.stdout ?? "").trim() !== "true") {
    throw new Error("--repository must point to a bare Git repository");
  }
  return {
    mode: "bare",
    sourceRoot: resolvedRepository,
    archiveRoot: archiveRootFor(resolvedRepository, "repository"),
  };
}

async function runStrictGitFsck(git: GitSource, run: ExecFile): Promise<void> {
  const args = git.mode === "bare"
    ? [`--git-dir=${git.sourceRoot}`, "fsck", "--full", "--strict", "--no-dangling"]
    : ["-C", git.sourceRoot, "fsck", "--full", "--strict", "--no-dangling"];
  try {
    await run("git", args, commandOptions());
  } catch (error) {
    throw new Error(`strict full-object Git verification failed: ${errorMessage(error)}`, { cause: error });
  }
}

async function readGitHead(git: GitSource, run: ExecFile): Promise<string | null> {
  const args = git.mode === "bare"
    ? [`--git-dir=${git.sourceRoot}`, "rev-parse", "--verify", "HEAD"]
    : ["-C", git.sourceRoot, "rev-parse", "--verify", "HEAD"];
  try {
    const result = await run("git", args, commandOptions());
    const head = (result.stdout ?? "").trim();
    return head || null;
  } catch (error) {
    if (isMissingHeadError(error)) return null;
    throw error;
  }
}

async function scanComponent(component: SourceComponent): Promise<ScannedEntry[]> {
  const entries: ScannedEntry[] = [];
  await walk(component.sourceRoot, "");
  return entries;

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const relPath = normalizeArchivePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
      assertPortableRelativePath(relPath, "source path");
      if (isExcludedPath(component.role, relPath)) continue;
      const absPath = join(directory, child.name);
      const childStats = await lstat(absPath);
      if (childStats.isSymbolicLink()) {
        throw new Error(`backup refuses symbolic links: ${component.role}/${relPath}`);
      }
      if (childStats.isDirectory()) {
        await walk(absPath, relPath);
        continue;
      }
      if (!childStats.isFile()) {
        throw new Error(`backup refuses non-regular files: ${component.role}/${relPath}`);
      }
      if (!Number.isSafeInteger(childStats.size)) {
        throw new Error(`backup file is too large to represent safely: ${component.role}/${relPath}`);
      }
      const archivePath = `${component.archiveRoot}/${relPath}`;
      if (archivePath === MANIFEST_NAME) throw new Error(`${MANIFEST_NAME} is reserved by the backup format`);
      entries.push({
        component: component.role,
        path: archivePath,
        sizeBytes: childStats.size,
        sha256: await sha256File(absPath),
        absPath,
        ...(component.role === "vault" ? { vaultRelativePath: relPath } : {}),
      });
    }
  }
}

async function stageComponentDirectories(component: SourceComponent, stagingRoot: string): Promise<void> {
  await mkdir(safeJoin(stagingRoot, component.archiveRoot), { recursive: true });
  await walk(component.sourceRoot, "");

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const relPath = normalizeArchivePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
      assertPortableRelativePath(relPath, "source path");
      if (isExcludedPath(component.role, relPath)) continue;
      const absPath = join(directory, child.name);
      const childStats = await lstat(absPath);
      if (childStats.isSymbolicLink()) {
        throw new Error(`backup refuses symbolic links: ${component.role}/${relPath}`);
      }
      if (!childStats.isDirectory()) continue;
      await mkdir(safeJoin(stagingRoot, `${component.archiveRoot}/${relPath}`), { recursive: true });
      await walk(absPath, relPath);
    }
  }
}

function isExcludedPath(component: BackupComponent, relPath: string): boolean {
  if (component === "repository") {
    return /(?:^|\/)[^/]+\.lock$/u.test(relPath) || /(?:^|\/)gc\.log$/u.test(relPath);
  }
  const parts = relPath.split("/");
  const first = parts[0] ?? "";
  if (["backups", "logs", "var"].includes(first)) return true;
  if (["errors.log", "auto-sync.log", ".auto-push-pending.lock"].includes(relPath)) return true;
  if (first === "embeddings" && relPath !== "embeddings/auto-heal.jsonl") return true;
  if (first === "raw" && relPath.endsWith(".tmp")) return true;
  return /(?:^|\/)[^/]+\.[^/]+\.lock$/u.test(relPath);
}

async function selectRestoreCanary(entries: readonly ScannedEntry[]): Promise<BackupManifest["canary"]> {
  let selected: { query: string; expectedPath: string; score: number } | null = null;
  for (const entry of entries) {
    const expectedPath = entry.vaultRelativePath;
    if (!expectedPath || !/^(?:raw|wiki)\/.*\.md$/iu.test(expectedPath)) continue;
    const sample = await readUtf8Prefix(entry.absPath, CANARY_SAMPLE_BYTES);
    const tokens = sample.match(/[\p{L}\p{N}_]{4,128}/gu) ?? [];
    for (const rawToken of tokens) {
      if (/^\p{N}+$/u.test(rawToken)) continue;
      if (["AND", "OR", "NOT", "NEAR"].includes(rawToken.toUpperCase())) continue;
      const query = rawToken.normalize("NFC");
      const score = [...query].length;
      const candidate = { query, expectedPath, score };
      if (
        selected === null
        || candidate.score > selected.score
        || (candidate.score === selected.score && compareText(candidate.expectedPath, selected.expectedPath) < 0)
        || (
          candidate.score === selected.score
          && candidate.expectedPath === selected.expectedPath
          && compareText(candidate.query, selected.query) < 0
        )
      ) {
        selected = candidate;
      }
    }
  }
  if (!selected) {
    throw new Error("backup needs at least one searchable Markdown token under wiki/ or raw/ for its restore canary");
  }
  return { query: selected.query, expectedPath: selected.expectedPath };
}

async function verifyExtractedFiles(extractionRoot: string, manifest: BackupManifest): Promise<void> {
  const actual = new Map<string, { sizeBytes: number; sha256: string }>();
  await walk(extractionRoot, "");
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));

  for (const [path, entry] of expected) {
    const restored = actual.get(path);
    if (!restored) throw new Error(`manifest entry is missing after extraction: ${path}`);
    if (restored.sizeBytes !== entry.sizeBytes) {
      throw new Error(`size mismatch for ${path}: expected ${entry.sizeBytes}, got ${restored.sizeBytes}`);
    }
    if (restored.sha256 !== entry.sha256) {
      throw new Error(`SHA-256 mismatch for ${path}: expected ${entry.sha256}, got ${restored.sha256}`);
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) throw new Error(`archive contains an unmanifested file: ${path}`);
  }

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const relPath = normalizeArchivePath(relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name);
      if (relPath === MANIFEST_NAME) continue;
      const absPath = join(directory, child.name);
      const childStats = await lstat(absPath);
      if (childStats.isSymbolicLink()) throw new Error(`archive contains a symbolic link: ${relPath}`);
      if (childStats.isDirectory()) {
        await walk(absPath, relPath);
      } else if (childStats.isFile()) {
        actual.set(relPath, { sizeBytes: childStats.size, sha256: await sha256File(absPath) });
      } else {
        throw new Error(`archive contains a non-regular file: ${relPath}`);
      }
    }
  }
}

function parseManifest(text: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`backup manifest is not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
  validateManifest(parsed);
  return parsed;
}

function validateManifest(value: unknown): asserts value is BackupManifest {
  if (!isRecord(value)) throw new Error("backup manifest must be a JSON object");
  if (value["schemaVersion"] !== BACKUP_SCHEMA_VERSION || value["kind"] !== "memory-fort-backup") {
    throw new Error("unsupported backup manifest schema");
  }
  if (typeof value["createdAt"] !== "string" || !Number.isFinite(Date.parse(value["createdAt"]))) {
    throw new Error("backup manifest createdAt is invalid");
  }
  const protection = value["protection"];
  if (
    !isRecord(protection)
    || !["local-same-device", "local-different-device"].includes(String(protection["class"]))
    || protection["offHostVerified"] !== false
    || protection["basis"] !== "filesystem-device-id"
  ) {
    throw new Error("backup manifest protection classification is invalid");
  }
  const vault = value["vault"];
  const git = value["git"];
  const canary = value["canary"];
  const summary = value["summary"];
  const restore = value["restore"];
  if (!isRecord(vault) || typeof vault["archiveRoot"] !== "string") throw new Error("backup manifest vault is invalid");
  assertArchiveRoot(vault["archiveRoot"], "vault archive root");
  if (
    !isRecord(git)
    || !["worktree", "bare"].includes(String(git["mode"]))
    || typeof git["archiveRoot"] !== "string"
    || (git["head"] !== null && (typeof git["head"] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(git["head"])))
    || git["verification"] !== "git-fsck-full-strict"
  ) {
    throw new Error("backup manifest Git metadata is invalid");
  }
  assertArchiveRoot(git["archiveRoot"], "Git archive root");
  if (
    !isRecord(canary)
    || typeof canary["query"] !== "string"
    || !/^[\p{L}\p{N}_]{4,128}$/u.test(canary["query"])
    || typeof canary["expectedPath"] !== "string"
    || !/^(?:raw|wiki)\/.*\.md$/iu.test(canary["expectedPath"])
  ) {
    throw new Error("backup manifest restore canary is invalid");
  }
  assertPortableRelativePath(canary["expectedPath"], "restore canary path");
  if (
    !isRecord(summary)
    || !Number.isSafeInteger(summary["fileCount"])
    || Number(summary["fileCount"]) < 1
    || !Number.isSafeInteger(summary["totalBytes"])
    || Number(summary["totalBytes"]) < 0
  ) {
    throw new Error("backup manifest summary is invalid");
  }
  if (
    !isRecord(restore)
    || restore["policy"] !== "extract-to-new-directory-only"
    || !Array.isArray(restore["instructions"])
    || restore["instructions"].some((line) => typeof line !== "string")
  ) {
    throw new Error("backup manifest restore policy is invalid");
  }
  if (!Array.isArray(value["exclusions"]) || value["exclusions"].some((entry) => typeof entry !== "string")) {
    throw new Error("backup manifest exclusions are invalid");
  }
  if (!Array.isArray(value["entries"]) || value["entries"].length !== summary["fileCount"]) {
    throw new Error("backup manifest entry count does not match its summary");
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  let previousPath: string | null = null;
  for (const rawEntry of value["entries"]) {
    if (!isRecord(rawEntry)) throw new Error("backup manifest entry is invalid");
    const component = rawEntry["component"];
    const path = rawEntry["path"];
    const sizeBytes = rawEntry["sizeBytes"];
    const sha256 = rawEntry["sha256"];
    if (component !== "vault" && component !== "repository") {
      throw new Error("backup manifest component is invalid");
    }
    if (typeof path !== "string") throw new Error("backup manifest entry path is invalid");
    assertPortableRelativePath(path, "manifest entry path");
    if (path === MANIFEST_NAME) throw new Error(`${MANIFEST_NAME} cannot be a payload entry`);
    if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) throw new Error(`invalid size for ${path}`);
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`invalid SHA-256 for ${path}`);
    const expectedRoot = component === "vault" ? vault["archiveRoot"] : git["archiveRoot"];
    if (path !== expectedRoot && !path.startsWith(`${expectedRoot}/`)) {
      throw new Error(`manifest entry ${path} is outside its component root`);
    }
    if (seen.has(path)) throw new Error(`duplicate backup manifest path: ${path}`);
    if (previousPath !== null && compareText(previousPath, path) >= 0) {
      throw new Error("backup manifest entries must be strictly sorted by path");
    }
    seen.add(path);
    previousPath = path;
    totalBytes += Number(sizeBytes);
  }
  if (totalBytes !== summary["totalBytes"]) throw new Error("backup manifest byte total does not match its summary");
  const canaryArchivePath = `${vault["archiveRoot"]}/${canary["expectedPath"]}`;
  if (!seen.has(canaryArchivePath)) throw new Error("backup manifest canary path is not present in the payload");
  if (git["mode"] === "worktree" && git["archiveRoot"] !== vault["archiveRoot"]) {
    throw new Error("worktree Git metadata must live in the vault component");
  }
  if (git["mode"] === "bare" && !value["entries"].some((entry) => isRecord(entry) && entry["component"] === "repository")) {
    throw new Error("bare Git backup has no repository payload");
  }
}

function validateArchiveListing(stdout: string): Set<string> {
  const files = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (!rawLine) continue;
    const directory = rawLine.endsWith("/");
    const normalized = normalizeArchivePath(rawLine.replace(/^\.\//u, "").replace(/\/$/u, ""));
    if (!normalized || normalized === ".") continue;
    assertPortableRelativePath(normalized, "archive entry");
    if (directory) continue;
    if (files.has(normalized)) throw new Error(`archive contains a duplicate file entry: ${normalized}`);
    files.add(normalized);
  }
  if (!files.has(MANIFEST_NAME)) throw new Error(`archive does not contain ${MANIFEST_NAME}`);
  return files;
}

function assertListingMatchesManifest(listedFiles: Set<string>, manifest: BackupManifest): void {
  const expected = new Set([MANIFEST_NAME, ...manifest.entries.map((entry) => entry.path)]);
  for (const path of expected) {
    if (!listedFiles.has(path)) throw new Error(`archive listing is missing manifested file: ${path}`);
  }
  for (const path of listedFiles) {
    if (!expected.has(path)) throw new Error(`archive listing contains an unmanifested file: ${path}`);
  }
}

async function resolveExistingDirectory(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  const pathStats = await stat(resolved).catch(() => null);
  if (!pathStats?.isDirectory()) throw new Error(`${label} directory does not exist: ${resolved}`);
  return realpath(resolved);
}

async function resolveTargetDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  await mkdir(resolved, { recursive: true });
  return resolveExistingDirectory(resolved, "backup target");
}

function assertTargetOutsideSource(sourceRoot: string, targetDir: string, label: string): void {
  if (isWithin(sourceRoot, targetDir)) throw new Error(`backup target must be outside the ${label}`);
}

function assertNonOverlappingSources(left: string, right: string): void {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new Error("vault and external repository paths must not overlap");
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function archiveRootFor(sourceRoot: string, label: string): string {
  const root = basename(sourceRoot);
  assertArchiveRoot(root, `${label} archive root`);
  if (root === MANIFEST_NAME) throw new Error(`${label} directory name conflicts with ${MANIFEST_NAME}`);
  return root;
}

function assertDistinctArchiveRoots(components: readonly SourceComponent[]): void {
  const seen = new Set<string>();
  for (const component of components) {
    const folded = process.platform === "win32" ? component.archiveRoot.toLowerCase() : component.archiveRoot;
    if (seen.has(folded)) throw new Error("vault and repository must have distinct directory names for a portable archive");
    seen.add(folded);
  }
}

function assertArchiveRoot(value: string, label: string): void {
  assertPortableRelativePath(value, label);
  if (value.includes("/")) throw new Error(`${label} must be one path segment`);
}

function assertPortableRelativePath(value: string, label: string): void {
  if (
    !value
    || value === "."
    || isAbsolute(value)
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} is not a safe portable relative path: ${JSON.stringify(value)}`);
  }
}

function safeJoin(root: string, relativePath: string): string {
  assertPortableRelativePath(relativePath, "manifest path");
  const joined = resolve(root, ...relativePath.split("/"));
  if (!isWithin(root, joined)) throw new Error(`manifest path escapes extraction root: ${relativePath}`);
  return joined;
}

function normalizeArchivePath(path: string): string {
  return path.replace(/\\/gu, "/").normalize("NFC");
}

function archiveFileName(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.]/gu, "");
  return `memory-fort-${timestamp}.tar.gz`;
}

async function makeOperationRoot(parent: string | undefined, prefix: string): Promise<string> {
  const root = parent ? resolve(parent) : tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function readUtf8Prefix(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", rejectHash);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandOptions(): ExecFileOptions {
  return {
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: MAX_COMMAND_BUFFER_BYTES,
    encoding: "utf8",
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingHeadError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error["code"];
  const stderr = typeof error["stderr"] === "string" ? error["stderr"] : "";
  return code === 128 && /needed a single revision|unknown revision|ambiguous argument 'HEAD'/iu.test(stderr);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
