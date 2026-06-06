import { existsSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  checkPruneCandidates,
  loadWiki,
  type PruneCandidate,
} from "../../curation/checks.js";
import {
  markEmbeddingsArchived,
  type EmbeddingKind,
} from "../../retrieval/embeddings-store.js";
import { loadMemoryConfig } from "../../storage/config.js";
import { formatIsoDate, memoryRoot } from "../../storage/paths.js";

export type PruneMode = "plan" | "apply" | "restore";

export interface PruneOptions {
  mode: PruneMode;
  path?: string;
  now?: Date;
}

export interface PruneMove {
  from: string;
  to: string;
}

export interface PruneResult {
  mode: PruneMode;
  candidates: PruneCandidate[];
  moved: PruneMove[];
  restored: PruneMove | null;
  report: string;
}

const DEFAULT_RAW_PRUNE_DAYS = 90;

export async function runPrune(opts: PruneOptions): Promise<PruneResult> {
  const root = memoryRoot();
  const now = opts.now ?? new Date();

  if (opts.mode === "restore") {
    if (!opts.path) {
      throw new Error("memory prune --restore requires an archived path");
    }
    const restored = await restoreArchivedPath(root, opts.path);
    await updateEmbeddingArchiveFlags(root, [restored.to], false);
    return {
      mode: "restore",
      candidates: [],
      moved: [],
      restored,
      report: formatPruneReport("restore", [], [], restored),
    };
  }

  const config = await loadMemoryConfig(root);
  const rawWindowDays = readRawWindowDays(config.retention?.raw_window_days);
  const candidates = await planPrune(root, now, rawWindowDays);
  if (opts.mode === "plan") {
    return {
      mode: "plan",
      candidates,
      moved: [],
      restored: null,
      report: formatPruneReport("plan", candidates, [], null),
    };
  }

  const archiveDate = formatIsoDate(now);
  const moved: PruneMove[] = [];
  for (const candidate of candidates) {
    moved.push(await archiveCandidate(root, candidate.path, archiveDate));
  }
  await updateEmbeddingArchiveFlags(root, moved.map((move) => move.from), true);

  return {
    mode: "apply",
    candidates,
    moved,
    restored: null,
    report: formatPruneReport("apply", candidates, moved, null),
  };
}

async function planPrune(root: string, now: Date, rawWindowDays: number): Promise<PruneCandidate[]> {
  const wikiPages = await loadWiki(join(root, "wiki"));
  return [
    ...checkPruneCandidates(wikiPages, { now }),
    ...(await rawPruneCandidates(root, wikiPages, now, rawWindowDays)),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

async function rawPruneCandidates(
  root: string,
  wikiPages: Awaited<ReturnType<typeof loadWiki>>,
  now: Date,
  rawWindowDays: number,
): Promise<PruneCandidate[]> {
  const rawRoot = join(root, "raw");
  if (!existsSync(rawRoot)) return [];
  const referenced = rawReferences(wikiPages);
  const cutoff = now.getTime() - rawWindowDays * 24 * 60 * 60 * 1000;
  const candidates: PruneCandidate[] = [];

  for (const relPath of await listRawMarkdown(rawRoot)) {
    if (referenced.has(relPath) || referenced.has(relPath.split("/").at(-1)!)) {
      continue;
    }
    const rawDate = rawDateFromRelPath(relPath);
    const timestamp = rawDate ? Date.parse(rawDate) : NaN;
    const ageSource = Number.isFinite(timestamp)
      ? timestamp
      : (await stat(join(root, relPath))).mtimeMs;
    if (ageSource >= cutoff) continue;
    candidates.push({
      category: "large-raw",
      path: relPath,
      title: relPath.split("/").at(-1) ?? relPath,
      updated: rawDate,
      confidence: null,
    });
  }

  return candidates;
}

function readRawWindowDays(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_RAW_PRUNE_DAYS;
}

async function listRawMarkdown(rawRoot: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
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

function rawReferences(wikiPages: Awaited<ReturnType<typeof loadWiki>>): Set<string> {
  const references = new Set<string>();
  for (const page of wikiPages) {
    for (const match of page.body.matchAll(/raw\/[A-Za-z0-9._/-]+\.md/g)) {
      references.add(match[0]!);
    }
    for (const match of page.body.matchAll(/[A-Za-z0-9._-]+\.md/g)) {
      references.add(match[0]!);
    }
  }
  return references;
}

function rawDateFromRelPath(relPath: string): string | null {
  const match = /^raw\/(\d{4}-\d{2}-\d{2})\//.exec(relPath);
  return match?.[1] ?? null;
}

async function archiveCandidate(
  root: string,
  relPath: string,
  archiveDate: string,
): Promise<PruneMove> {
  const from = safeResolveUnder(root, relPath);
  if (!from || !existsSync(from)) {
    throw new Error(`memory prune: cannot archive missing path ${relPath}`);
  }
  const toRelPath = `wiki/archive/${archiveDate}/${relPath}`;
  const to = safeResolveUnder(root, toRelPath);
  if (!to) throw new Error(`memory prune: invalid archive target ${toRelPath}`);
  if (existsSync(to)) {
    throw new Error(`memory prune: archive target already exists ${toRelPath}`);
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { from: relPath, to: toRelPath };
}

async function restoreArchivedPath(root: string, inputPath: string): Promise<PruneMove> {
  const normalized = normalizeRelPath(inputPath);
  const archiveRelPath = normalized.startsWith("wiki/archive/")
    ? normalized
    : await findArchivedPath(root, normalized);
  const parts = archiveRelPath.split("/");
  if (parts.length < 5 || parts[0] !== "wiki" || parts[1] !== "archive") {
    throw new Error(`memory prune --restore: invalid archive path ${inputPath}`);
  }
  const originalRelPath = parts.slice(3).join("/");
  const from = safeResolveUnder(root, archiveRelPath);
  const to = safeResolveUnder(root, originalRelPath);
  if (!from || !existsSync(from)) {
    throw new Error(`memory prune --restore: archive file not found ${archiveRelPath}`);
  }
  if (!to) throw new Error(`memory prune --restore: invalid target ${originalRelPath}`);
  if (existsSync(to)) {
    throw new Error(`memory prune --restore: target already exists ${originalRelPath}`);
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { from: archiveRelPath, to: originalRelPath };
}

async function findArchivedPath(root: string, originalRelPath: string): Promise<string> {
  const archiveRoot = join(root, "wiki", "archive");
  if (!existsSync(archiveRoot)) {
    throw new Error(`memory prune --restore: no archive found for ${originalRelPath}`);
  }
  const dates = await readdir(archiveRoot, { withFileTypes: true });
  const matches = dates
    .filter((entry) => entry.isDirectory())
    .map((entry) => `wiki/archive/${entry.name}/${originalRelPath}`)
    .filter((relPath) => existsSync(join(root, ...relPath.split("/"))))
    .sort()
    .reverse();
  if (matches.length === 0) {
    throw new Error(`memory prune --restore: no archive found for ${originalRelPath}`);
  }
  return matches[0]!;
}

async function updateEmbeddingArchiveFlags(
  root: string,
  relPaths: string[],
  archived: boolean,
): Promise<void> {
  const byKind = new Map<EmbeddingKind, Set<string>>();
  for (const relPath of relPaths) {
    const kind = embeddingKindForPath(relPath);
    if (!kind) continue;
    const paths = byKind.get(kind) ?? new Set<string>();
    paths.add(relPath);
    byKind.set(kind, paths);
  }

  for (const [kind, paths] of byKind) {
    await markEmbeddingsArchived(root, kind, paths, archived);
  }
}

function embeddingKindForPath(relPath: string): EmbeddingKind | null {
  if (relPath.startsWith("wiki/")) return "wiki";
  if (relPath.startsWith("raw/")) return "raw";
  if (relPath.startsWith("crystals/")) return "crystal";
  return null;
}

function safeResolveUnder(root: string, relPath: string): string | null {
  const normalized = normalizeRelPath(relPath);
  if (isAbsolute(normalized) || normalized.startsWith("../")) return null;
  const finalPath = resolve(root, ...normalized.split("/"));
  const rel = relative(resolve(root), finalPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
    ? finalPath
    : null;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function formatPruneReport(
  mode: PruneMode,
  candidates: PruneCandidate[],
  moved: PruneMove[],
  restored: PruneMove | null,
): string {
  const lines = [`Memory prune ${mode}`];
  if (restored) {
    lines.push(`Restored: ${restored.from} -> ${restored.to}`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Candidates: ${candidates.length}`);
  for (const candidate of candidates) {
    lines.push(`- [${candidate.category}] ${candidate.path}`);
  }
  if (moved.length > 0) {
    lines.push("", "Moved:");
    for (const move of moved) lines.push(`- ${move.from} -> ${move.to}`);
  }
  return `${lines.join("\n")}\n`;
}
