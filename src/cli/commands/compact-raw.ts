import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { readCompileStateFile, readConsumedMap, writeCompileStateFile } from "../../compile/state.js";
import { truncateMiddle } from "../../hooks/raw-file.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import { formatIsoDate, memoryRoot } from "../../storage/paths.js";
import {
  commitVaultChange as defaultCommitVaultChange,
  type CommitVaultChangeResult,
} from "../../sync/commit-vault-change.js";

export type CompactRawMode = "plan" | "apply";

export interface CompactRawOptions {
  vaultRoot?: string;
  mode: CompactRawMode;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  now?: Date;
  commitVaultChange?: typeof defaultCommitVaultChange;
}

export interface CompactRawFileResult {
  path: string;
  bytesBefore: number;
  bytesAfter: number;
  bytesReclaimed: number;
  observationsCompacted: number;
}

export interface CompactRawArchive {
  from: string;
  to: string;
}

export interface CompactRawResult {
  mode: CompactRawMode;
  files: CompactRawFileResult[];
  archived: CompactRawArchive[];
  watermarksClamped: string[];
  totalBytesBefore: number;
  totalBytesAfter: number;
  totalBytesReclaimed: number;
  commit?: CommitVaultChangeResult;
  report: string;
}

interface CompactedText {
  text: string;
  observationsCompacted: number;
}

const DEFAULT_CAPTURE_MAX_BYTES = 8192;
const TOOL_USE_RE =
  /(\n## \[(\d{2}:\d{2}:\d{2})\] ToolUse: ([^\n]+)\n\n\*\*Input:\*\*\n\n```json\n)([\s\S]*?)(\n```\n\n\*\*Output:\*\*\n\n```\n)([\s\S]*?)(\n```)/g;

export async function runCompactRaw(opts: CompactRawOptions): Promise<CompactRawResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const maxInputBytes = readNonNegativeInteger(opts.maxInputBytes, DEFAULT_CAPTURE_MAX_BYTES, "maxInputBytes");
  const maxOutputBytes = readNonNegativeInteger(opts.maxOutputBytes, DEFAULT_CAPTURE_MAX_BYTES, "maxOutputBytes");
  const rawFiles = await listRawMarkdown(root);
  const files: CompactRawFileResult[] = [];
  const rewrites: Array<{ relPath: string; next: string }> = [];

  for (const relPath of rawFiles) {
    const fullPath = join(root, ...relPath.split("/"));
    const original = await readFile(fullPath, "utf-8");
    const compacted = compactRawText(original, { maxInputBytes, maxOutputBytes });
    if (compacted.text === original) continue;
    const bytesBefore = Buffer.byteLength(original, "utf-8");
    const bytesAfter = Buffer.byteLength(compacted.text, "utf-8");
    files.push({
      path: relPath,
      bytesBefore,
      bytesAfter,
      bytesReclaimed: bytesBefore - bytesAfter,
      observationsCompacted: compacted.observationsCompacted,
    });
    rewrites.push({ relPath, next: compacted.text });
  }

  const totals = totalFileBytes(files);
  if (opts.mode === "plan" || rewrites.length === 0) {
    return {
      mode: opts.mode,
      files,
      archived: [],
      watermarksClamped: [],
      ...totals,
      report: formatCompactRawReport(opts.mode, files, [], [], undefined),
    };
  }

  const archiveDate = formatIsoDate(opts.now ?? new Date());
  const archived: CompactRawArchive[] = [];
  for (const rewrite of rewrites) {
    const archive = await archiveOriginal(root, rewrite.relPath, archiveDate);
    archived.push(archive);
    await atomicWrite(join(root, ...rewrite.relPath.split("/")), rewrite.next);
  }

  const watermarksClamped = await clampConsumedWatermarks(root, files);
  const commitPaths = [
    ...files.map((file) => file.path),
    ...archived.map((archive) => archive.to),
    ...(watermarksClamped.length > 0 ? ["state/compile-state.json"] : []),
  ];
  const commit = await (opts.commitVaultChange ?? defaultCommitVaultChange)({
    memoryRoot: root,
    paths: commitPaths,
    message: "compact raw observations",
  });

  return {
    mode: "apply",
    files,
    archived,
    watermarksClamped,
    ...totals,
    commit,
    report: formatCompactRawReport("apply", files, archived, watermarksClamped, commit),
  };
}

function compactRawText(
  text: string,
  caps: { maxInputBytes: number; maxOutputBytes: number },
): CompactedText {
  let observationsCompacted = 0;
  const next = text.replace(
    TOOL_USE_RE,
    (full, prefix: string, _time: string, _toolName: string, inputText: string, middle: string, outputText: string, suffix: string) => {
      const nextInput = truncateMiddle(inputText, caps.maxInputBytes);
      const nextOutput = truncateMiddle(outputText, caps.maxOutputBytes);
      if (nextInput === inputText && nextOutput === outputText) return full;
      observationsCompacted += 1;
      return `${prefix}${nextInput}${middle}${nextOutput}${suffix}`;
    },
  );
  return { text: next, observationsCompacted };
}

async function listRawMarkdown(root: string): Promise<string[]> {
  const rawRoot = join(root, "raw");
  if (!existsSync(rawRoot)) return [];
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".compact-archive") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(`raw/${relative(rawRoot, full).replace(/\\/g, "/")}`);
      }
    }
  }

  await walk(rawRoot);
  return files.sort();
}

async function archiveOriginal(
  root: string,
  relPath: string,
  archiveDate: string,
): Promise<CompactRawArchive> {
  const from = safeResolveUnder(root, relPath);
  if (!from || !existsSync(from)) {
    throw new Error(`memory compact-raw: missing raw file ${relPath}`);
  }
  const rawRelPath = relPath.replace(/^raw\//, "");
  const archiveRelPath = await uniqueArchivePath(root, `raw/.compact-archive/${archiveDate}/${rawRelPath}`);
  const to = safeResolveUnder(root, archiveRelPath);
  if (!to) throw new Error(`memory compact-raw: invalid archive target ${archiveRelPath}`);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  return { from: relPath, to: archiveRelPath };
}

async function uniqueArchivePath(root: string, relPath: string): Promise<string> {
  if (!existsSync(join(root, ...relPath.split("/")))) return relPath;
  const ext = extname(relPath);
  const base = ext ? relPath.slice(0, -ext.length) : relPath;
  for (let i = 1; i < 10_000; i += 1) {
    const candidate = `${base}-${i}${ext}`;
    if (!existsSync(join(root, ...candidate.split("/")))) return candidate;
  }
  throw new Error(`memory compact-raw: could not allocate archive path for ${relPath}`);
}

async function clampConsumedWatermarks(root: string, files: CompactRawFileResult[]): Promise<string[]> {
  const state = await readCompileStateFile(root);
  const consumed = readConsumedMap(state);
  const changed: string[] = [];
  for (const file of files) {
    const watermark = consumed[file.path];
    if (!watermark) continue;
    const size = (await stat(join(root, ...file.path.split("/")))).size;
    if (watermark.bytes > size) {
      consumed[file.path] = { ...watermark, bytes: size };
      changed.push(file.path);
    }
  }
  if (changed.length > 0) {
    await writeCompileStateFile(root, { ...state, consumed });
  }
  return changed;
}

function totalFileBytes(files: CompactRawFileResult[]): Pick<
  CompactRawResult,
  "totalBytesBefore" | "totalBytesAfter" | "totalBytesReclaimed"
> {
  return {
    totalBytesBefore: files.reduce((sum, file) => sum + file.bytesBefore, 0),
    totalBytesAfter: files.reduce((sum, file) => sum + file.bytesAfter, 0),
    totalBytesReclaimed: files.reduce((sum, file) => sum + file.bytesReclaimed, 0),
  };
}

function formatCompactRawReport(
  mode: CompactRawMode,
  files: CompactRawFileResult[],
  archived: CompactRawArchive[],
  watermarksClamped: string[],
  commit: CommitVaultChangeResult | undefined,
): string {
  const totals = totalFileBytes(files);
  const lines = [
    `compact-raw ${mode}: ${files.length} file(s), ${totals.totalBytesReclaimed} byte(s) reclaimable`,
    `  before: ${totals.totalBytesBefore}`,
    `  after:  ${totals.totalBytesAfter}`,
  ];
  for (const file of files) {
    lines.push(`  - ${file.path}: ${file.bytesReclaimed} byte(s), ${file.observationsCompacted} observation(s)`);
  }
  if (archived.length > 0) lines.push(`  archived: ${archived.length}`);
  if (watermarksClamped.length > 0) lines.push(`  watermarks clamped: ${watermarksClamped.length}`);
  if (commit) lines.push(`  commit: ${commit.kind}`);
  return `${lines.join("\n")}\n`;
}

function readNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`memory compact-raw: ${name} must be a non-negative integer`);
  }
  return n;
}

function safeResolveUnder(root: string, relPath: string): string | null {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relPath);
  const rel = relative(resolvedRoot, resolved).replace(/\\/g, "/");
  return rel.length === 0 || rel.startsWith("../") || rel === ".." ? null : resolved;
}
