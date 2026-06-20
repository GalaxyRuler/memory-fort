import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export type RawCaptureSource =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "claude-desktop"
  | "chatgpt"
  | "hermes"
  | "pi"
  | "openclaw"
  | "opencode"
  | "opencoven"
  | "vscode"
  | "manual"
  | "unknown";

export interface RawCaptureFile {
  date: string;
  filename: string;
  relPath: string;
  fullPath: string;
  source: RawCaptureSource;
  sessionId: string;
  sizeBytes: number;
  mtime: Date;
  mtimeMs: number;
}

export interface ListRawCaptureFilesOptions {
  prefixes?: readonly string[];
  from?: Date;
  to?: Date;
  cache?: RawCaptureScanCache;
}

export interface RawCaptureScanCache {
  directories: Map<string, RawCaptureDirectoryCacheEntry>;
  stats: {
    directoryCacheHits: number;
    directoryRefreshes: number;
  };
}

interface RawCaptureDirectoryCacheEntry {
  fingerprint: string;
  captures: RawCaptureFile[];
}

const RAW_CAPTURE_SESSION_PREFIXES = [
  "claude-code-agent-",
  "claude-code-",
  "claude-desktop-",
  "antigravity-",
  "chatgpt-",
  "hermes-",
  "pi-",
  "openclaw-",
  "opencode-",
  "opencoven-",
  "vscode-",
  "manual-mcp-",
  "manual-",
  "codex-",
] as const;

export function createRawCaptureScanCache(): RawCaptureScanCache {
  return {
    directories: new Map(),
    stats: {
      directoryCacheHits: 0,
      directoryRefreshes: 0,
    },
  };
}

export async function listRawCaptureFiles(
  vaultRoot: string,
  opts: ListRawCaptureFilesOptions = {},
): Promise<RawCaptureFile[]> {
  const rawRoot = join(vaultRoot, "raw");
  const captures: RawCaptureFile[] = [];
  let dateEntries;
  try {
    dateEntries = await readdir(rawRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory()) continue;
    const fullDir = join(rawRoot, dateEntry.name);
    const directoryCaptures = opts.cache
      ? await readCachedRawCaptureDirectory(vaultRoot, fullDir, dateEntry.name, opts.cache)
      : await readRawCaptureDirectory(vaultRoot, fullDir, dateEntry.name);
    captures.push(...directoryCaptures);
  }

  return captures
    .filter((capture) => !opts.prefixes || opts.prefixes.some((prefix) => capture.filename.startsWith(prefix)))
    .filter((capture) => !opts.from || capture.mtime.getTime() >= opts.from.getTime())
    .filter((capture) => !opts.to || capture.mtime.getTime() <= opts.to.getTime())
    .sort((a, b) =>
      b.mtimeMs - a.mtimeMs ||
      a.relPath.localeCompare(b.relPath)
    );
}

async function readCachedRawCaptureDirectory(
  vaultRoot: string,
  fullDir: string,
  date: string,
  cache: RawCaptureScanCache,
): Promise<RawCaptureFile[]> {
  const captures = await readRawCaptureDirectory(vaultRoot, fullDir, date);
  const fingerprint = rawCaptureDirectoryFingerprint(captures);
  const cached = cache.directories.get(fullDir);
  if (cached?.fingerprint === fingerprint) {
    cache.stats.directoryCacheHits += 1;
    return cached.captures;
  }
  cache.stats.directoryRefreshes += 1;
  cache.directories.set(fullDir, { fingerprint, captures });
  return captures;
}

async function readRawCaptureDirectory(
  vaultRoot: string,
  fullDir: string,
  date: string,
): Promise<RawCaptureFile[]> {
  const captures: RawCaptureFile[] = [];
  let fileEntries;
  try {
    fileEntries = await readdir(fullDir, { withFileTypes: true });
  } catch {
    return captures;
  }

  for (const fileEntry of fileEntries) {
    if (!fileEntry.isFile()) continue;
    if (!fileEntry.name.endsWith(".md")) continue;

    const fullPath = join(fullDir, fileEntry.name);
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;

    captures.push({
      date,
      filename: fileEntry.name,
      relPath: relative(vaultRoot, fullPath).replace(/\\/g, "/"),
      fullPath,
      source: parseRawCaptureSourceFromFilename(fileEntry.name),
      sessionId: parseRawCaptureSessionIdFromFilename(fileEntry.name),
      sizeBytes: info.size,
      mtime: info.mtime,
      mtimeMs: info.mtimeMs,
    });
  }

  return captures.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function rawCaptureDirectoryFingerprint(captures: RawCaptureFile[]): string {
  return captures
    .map((capture) => `${capture.filename}:${capture.mtimeMs}:${capture.sizeBytes}`)
    .join("|");
}

export function parseRawCaptureSourceFromFilename(filename: string): RawCaptureSource {
  if (filename.startsWith("claude-code-")) return "claude-code";
  if (filename.startsWith("codex-")) return "codex";
  if (filename.startsWith("antigravity-")) return "antigravity";
  if (filename.startsWith("claude-desktop-")) return "claude-desktop";
  if (filename.startsWith("chatgpt-")) return "chatgpt";
  if (filename.startsWith("hermes-")) return "hermes";
  if (filename.startsWith("pi-")) return "pi";
  if (filename.startsWith("openclaw-")) return "openclaw";
  if (filename.startsWith("opencode-")) return "opencode";
  if (filename.startsWith("opencoven-")) return "opencoven";
  if (filename.startsWith("vscode-")) return "vscode";
  if (filename.startsWith("manual-mcp-") || filename.startsWith("manual-")) return "manual";
  return "unknown";
}

export function parseRawCaptureSessionIdFromFilename(filename: string): string {
  const noExt = filename.replace(/\.md$/, "");
  for (const prefix of RAW_CAPTURE_SESSION_PREFIXES) {
    if (noExt.startsWith(prefix)) return noExt.slice(prefix.length);
  }
  return noExt;
}
