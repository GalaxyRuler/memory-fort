import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Frontmatter } from "../storage/frontmatter.js";

export interface DashboardStatus {
  vaultRoot: string;
  repoHead: {
    sha: string;
    shortSha: string;
    subject: string;
    committedAt: string;
  } | null;
  counts: {
    wikiPages: number;
    rawObservations: number;
    crystals: number;
  };
  lastCompile: {
    timestamp: string;
    line: string;
  } | null;
  errorsLog: {
    sizeBytes: number;
    lastLine: string | null;
    isClean: boolean;
  };
  syncState: {
    lastSyncAttempt: string | null;
    lastSyncSuccess: string | null;
    pendingPushCount: number;
    conflictsPending: number;
    conflictFiles: string[];
  } | null;
  generatedAt: string;
}

export type RunGit = (opts: { cwd: string; args: string[] }) => Promise<string>;

const execFileAsync = promisify(execFile);
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

export interface WikiIndexEntry {
  category: string;
  slug: string;
  relPath: string;
  title: string;
  summary: string;
  updated: string;
}

export interface WikiIndex {
  byCategory: Record<string, WikiIndexEntry[]>;
  total: number;
}

export interface PageDetail {
  relPath: string;
  fullPath: string;
  frontmatter: Frontmatter;
  body: string;
  relations: Array<{
    key: string;
    target: string;
    resolvedPath: string | null;
    resolvedTitle: string | null;
  }>;
  inbound: Array<{
    fromPath: string;
    fromTitle: string | null;
    via: string;
  }>;
}

export interface RawIndexEntry {
  date: string;
  files: Array<{ filename: string; sizeBytes: number; mtime: string }>;
}

export interface RawSession {
  date: string;
  filename: string;
  content: string;
  sizeBytes: number;
}

export interface LogTail {
  lines: string[];
  totalLines: number;
  requestedLines: number;
}

interface ResolutionIndex {
  byPath: Map<string, WikiPage>;
  byFilename: Map<string, WikiPage[]>;
  byTitle: Map<string, WikiPage[]>;
}

interface WikiPage {
  path: string;
  fullPath: string;
  frontmatter: Frontmatter;
  body: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isStrictChild(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  const rel = relative(parentResolved, childResolved);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function safeResolveUnder(root: string, ...parts: string[]): string | null {
  const finalPath = resolve(root, ...parts);
  return isStrictChild(root, finalPath) ? finalPath : null;
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "";
}

function readTitle(page: WikiPage): string | null {
  return typeof page.frontmatter.title === "string" ? page.frontmatter.title : null;
}

function firstNonEmptyLine(body: string): string {
  const line = body
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((item) => String(parseScalar(item)));
  }
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseWikiMarkdown(content: string): { frontmatter: Frontmatter; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: {} as Frontmatter, body: content };
  }

  const closing = /\r?\n---\r?\n/.exec(content.slice(3));
  if (!closing) {
    return { frontmatter: {} as Frontmatter, body: content };
  }

  const fmStart = 3;
  const fmEnd = fmStart + closing.index;
  const bodyStart = fmEnd + closing[0].length;
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentRelationKey: string | null = null;

  for (const line of content.slice(fmStart, fmEnd).replace(/^\r?\n/, "").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;

    const relationItem = /^ {4}- (.*)$/.exec(line);
    if (relationItem && currentKey === "relations" && currentRelationKey) {
      const relations = data["relations"] as Record<string, string[]>;
      relations[currentRelationKey]!.push(String(parseScalar(relationItem[1]!)));
      continue;
    }

    const nestedKey = /^ {2}([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nestedKey && currentKey === "relations") {
      currentRelationKey = nestedKey[1]!;
      const relations = (data["relations"] ??= {}) as Record<string, string[]>;
      const value = nestedKey[2]?.trim() ?? "";
      const parsed = parseScalar(value);
      relations[currentRelationKey] = Array.isArray(parsed) ? parsed.map(String) : [];
      continue;
    }

    const arrayItem = /^ {2}- (.*)$/.exec(line);
    if (arrayItem && currentKey) {
      const existing = data[currentKey];
      const values = Array.isArray(existing) ? existing : [];
      values.push(parseScalar(arrayItem[1]!));
      data[currentKey] = values;
      continue;
    }

    const separator = line.indexOf(":");
    if (separator === -1 || line.startsWith(" ")) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    currentKey = key;
    currentRelationKey = null;
    data[key] = value.length === 0 ? (key === "relations" ? {} : []) : parseScalar(value);
  }

  return { frontmatter: data as Frontmatter, body: content.slice(bodyStart) };
}

async function loadWikiPages(root: string): Promise<WikiPage[]> {
  if (!(await pathExists(root))) return [];
  const pages: WikiPage[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          const parsed = parseWikiMarkdown(content);
          pages.push({
            path: relative(root, full).replace(/\\/g, "/"),
            fullPath: full,
            frontmatter: parsed.frontmatter,
            body: parsed.body,
          });
        } catch {
          // Keep browse pages available even if one markdown file is unreadable.
        }
      }
    }
  }

  await walk(root);
  return pages;
}

function buildResolutionIndex(pages: WikiPage[]): ResolutionIndex {
  const byPath = new Map<string, WikiPage>();
  const byFilename = new Map<string, WikiPage[]>();
  const byTitle = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const noExt = page.path.replace(/\.md$/, "");
    byPath.set(noExt, page);
    const filename = noExt.split("/").pop()!;
    const existing = byFilename.get(filename) ?? [];
    existing.push(page);
    byFilename.set(filename, existing);

    const title = readTitle(page);
    if (title) {
      const titleMatches = byTitle.get(title) ?? [];
      titleMatches.push(page);
      byTitle.set(title, titleMatches);
    }
  }
  return { byPath, byFilename, byTitle };
}

function resolveLink(target: string, idx: ResolutionIndex): WikiPage | null {
  const clean = target.trim().replace(/\.md$/, "");
  const byPath = idx.byPath.get(clean);
  if (byPath) return byPath;
  const matches = idx.byFilename.get(clean) ?? [];
  if (matches.length === 1) return matches[0]!;
  const titleMatches = idx.byTitle.get(clean) ?? [];
  return titleMatches.length === 1 ? titleMatches[0]! : null;
}

function resolveRelations(page: WikiPage, idx: ResolutionIndex): PageDetail["relations"] {
  const relations = page.frontmatter.relations;
  if (!relations || typeof relations !== "object") return [];

  const result: PageDetail["relations"] = [];
  for (const key of Object.keys(relations).sort()) {
    const targets = relations[key];
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const resolved = resolveLink(target, idx);
      result.push({
        key,
        target,
        resolvedPath: resolved?.path ?? null,
        resolvedTitle: resolved ? readTitle(resolved) : null,
      });
    }
  }
  return result;
}

function findInbound(target: WikiPage, pages: WikiPage[], idx: ResolutionIndex): PageDetail["inbound"] {
  const inbound: PageDetail["inbound"] = [];
  for (const page of pages) {
    if (page.path === target.path) continue;

    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(page.body)) !== null) {
      const resolved = resolveLink(match[1]!, idx);
      if (resolved?.path === target.path) {
        inbound.push({ fromPath: page.path, fromTitle: readTitle(page), via: "wikilink" });
      }
    }

    const relations = page.frontmatter.relations;
    if (!relations || typeof relations !== "object") continue;
    for (const [key, targets] of Object.entries(relations)) {
      if (!Array.isArray(targets)) continue;
      for (const relTarget of targets) {
        if (typeof relTarget !== "string") continue;
        const resolved = resolveLink(relTarget, idx);
        if (resolved?.path === target.path) {
          inbound.push({ fromPath: page.path, fromTitle: readTitle(page), via: `relation:${key}` });
        }
      }
    }
  }

  return inbound.sort((a, b) => a.fromPath.localeCompare(b.fromPath) || a.via.localeCompare(b.via));
}

async function defaultRunGit(opts: { cwd: string; args: string[] }): Promise<string> {
  const { stdout } = await execFileAsync("git", opts.args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    windowsHide: true,
  });
  return stdout;
}

async function runBareRepoGit(vaultRoot: string, args: string[]): Promise<string> {
  const gitDir = join(dirname(vaultRoot), "memory.git");
  const { stdout } = await execFileAsync("git", [`--git-dir=${gitDir}`, ...args], {
    encoding: "utf-8",
    windowsHide: true,
  });
  return stdout;
}

export async function loadRepoHead(
  vaultRoot: string,
  runGit: RunGit = defaultRunGit,
): Promise<DashboardStatus["repoHead"]> {
  const args = ["log", "--format=%H%n%h%n%s%n%cI", "-n", "1"];
  let output = "";
  try {
    output = await runGit({ cwd: vaultRoot, args });
  } catch {
    try {
      output = await runBareRepoGit(vaultRoot, args);
    } catch {
      return null;
    }
  }

  const [sha = "", shortSha = "", subject = "", committedAt = ""] = output.trimEnd().split(/\r?\n/);
  if (!sha) return null;
  return { sha, shortSha, subject, committedAt };
}

async function countMarkdownFiles(root: string): Promise<number> {
  if (!(await pathExists(root))) return 0;
  let count = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      count += await countMarkdownFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      count += 1;
    }
  }
  return count;
}

export async function loadCounts(vaultRoot: string): Promise<DashboardStatus["counts"]> {
  const [wikiPages, rawObservations, crystals] = await Promise.all([
    countMarkdownFiles(join(vaultRoot, "wiki")),
    countMarkdownFiles(join(vaultRoot, "raw")),
    countMarkdownFiles(join(vaultRoot, "crystals")),
  ]);
  return { wikiPages, rawObservations, crystals };
}

export async function loadLastCompile(vaultRoot: string): Promise<DashboardStatus["lastCompile"]> {
  const path = join(vaultRoot, "log.md");
  if (!(await pathExists(path))) return null;
  const content = await readFile(path, "utf-8");
  let last: DashboardStatus["lastCompile"] = null;
  for (const line of content.split(/\r?\n/)) {
    const match = /^## \[(.*)\] compile \|/.exec(line);
    if (match) {
      last = { timestamp: match[1]!, line };
    }
  }
  return last;
}

export async function loadErrorsLog(vaultRoot: string): Promise<DashboardStatus["errorsLog"]> {
  const path = join(vaultRoot, "errors.log");
  if (!(await pathExists(path))) {
    return { sizeBytes: 0, lastLine: null, isClean: true };
  }
  const info = await stat(path);
  if (info.size === 0) {
    return { sizeBytes: 0, lastLine: null, isClean: true };
  }
  const content = await readFile(path, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    sizeBytes: info.size,
    lastLine: lines.at(-1) ?? null,
    isClean: info.size === 0,
  };
}

export async function loadSyncState(vaultRoot: string): Promise<DashboardStatus["syncState"]> {
  const path = join(vaultRoot, ".sync-state.json");
  if (!(await pathExists(path))) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    return {
      lastSyncAttempt: typeof parsed["last_sync_attempt"] === "string" ? parsed["last_sync_attempt"] : null,
      lastSyncSuccess: typeof parsed["last_sync_success"] === "string" ? parsed["last_sync_success"] : null,
      pendingPushCount: typeof parsed["pending_push_count"] === "number" ? parsed["pending_push_count"] : 0,
      conflictsPending: typeof parsed["conflicts_pending"] === "number" ? parsed["conflicts_pending"] : 0,
      conflictFiles: Array.isArray(parsed["conflict_files"])
        ? parsed["conflict_files"].filter((value): value is string => typeof value === "string")
        : [],
    };
  } catch (err) {
    console.warn(`dashboard: unable to read sync state: ${(err as Error).message}`);
    return null;
  }
}

export async function loadDashboardStatus(vaultRoot: string): Promise<DashboardStatus> {
  const [repoHead, counts, lastCompile, errorsLog, syncState] = await Promise.all([
    loadRepoHead(vaultRoot),
    loadCounts(vaultRoot),
    loadLastCompile(vaultRoot),
    loadErrorsLog(vaultRoot),
    loadSyncState(vaultRoot),
  ]);

  return {
    vaultRoot,
    repoHead,
    counts,
    lastCompile,
    errorsLog,
    syncState,
    generatedAt: new Date().toISOString(),
  };
}

export async function loadWikiIndex(vaultRoot: string): Promise<WikiIndex> {
  const wikiRoot = join(vaultRoot, "wiki");
  const pages = await loadWikiPages(wikiRoot);
  const entries = pages
    .map((page): WikiIndexEntry => {
      const noExt = page.path.replace(/\.md$/, "");
      const segments = noExt.split("/");
      const category = segments[0] ?? "";
      const slug = segments.at(-1) ?? noExt;
      return {
        category,
        slug,
        relPath: page.path,
        title: readTitle(page) ?? slug,
        summary: firstNonEmptyLine(page.body),
        updated: renderScalar(page.frontmatter.updated),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

  const byCategory: Record<string, WikiIndexEntry[]> = {};
  for (const entry of entries) {
    byCategory[entry.category] ??= [];
    byCategory[entry.category]!.push(entry);
  }

  return { byCategory, total: entries.length };
}

export async function loadPageDetail(vaultRoot: string, relPath: string): Promise<PageDetail | null> {
  if (relPath.includes("\\") || !relPath.endsWith(".md")) return null;
  const wikiRoot = join(vaultRoot, "wiki");
  const fullPath = safeResolveUnder(wikiRoot, relPath);
  if (!fullPath || !(await pathExists(fullPath))) return null;

  const pages = await loadWikiPages(wikiRoot);
  const page = pages.find((candidate) => candidate.path === relPath);
  if (!page) return null;

  const idx = buildResolutionIndex(pages);
  return {
    relPath: page.path,
    fullPath: page.fullPath,
    frontmatter: page.frontmatter,
    body: page.body,
    relations: resolveRelations(page, idx),
    inbound: findInbound(page, pages, idx),
  };
}

export async function loadRawIndex(vaultRoot: string): Promise<RawIndexEntry[]> {
  const rawRoot = join(vaultRoot, "raw");
  if (!(await pathExists(rawRoot))) return [];

  const dateEntries = await readdir(rawRoot, { withFileTypes: true });
  const result: RawIndexEntry[] = [];
  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory()) continue;
    const datePath = safeResolveUnder(rawRoot, dateEntry.name);
    if (!datePath) continue;
    const files = [];
    for (const fileEntry of await readdir(datePath, { withFileTypes: true })) {
      if (!fileEntry.isFile()) continue;
      const filePath = safeResolveUnder(datePath, fileEntry.name);
      if (!filePath) continue;
      const info = await stat(filePath);
      files.push({ filename: fileEntry.name, sizeBytes: info.size, mtime: info.mtime.toISOString() });
    }
    files.sort((a, b) => a.filename.localeCompare(b.filename));
    result.push({ date: dateEntry.name, files });
  }

  return result.sort((a, b) => b.date.localeCompare(a.date));
}

export async function loadRawSession(vaultRoot: string, date: string, filename: string): Promise<RawSession | null> {
  const rawRoot = join(vaultRoot, "raw");
  const fullPath = safeResolveUnder(rawRoot, date, filename);
  if (!fullPath || !(await pathExists(fullPath))) return null;
  const info = await stat(fullPath);
  if (!info.isFile()) return null;
  return {
    date,
    filename,
    content: await readFile(fullPath, "utf-8"),
    sizeBytes: info.size,
  };
}

export async function loadLogTail(vaultRoot: string, lineCount = 100): Promise<LogTail> {
  const requestedLines = Math.max(0, Math.floor(lineCount));
  const logPath = join(vaultRoot, "log.md");
  if (!(await pathExists(logPath))) {
    return { lines: [], totalLines: 0, requestedLines };
  }

  const content = await readFile(logPath, "utf-8");
  const normalized = content.replace(/\r?\n$/, "");
  const lines = normalized.length === 0 ? [] : normalized.split(/\r?\n/);
  return {
    lines: requestedLines === 0 ? [] : lines.slice(-requestedLines),
    totalLines: lines.length,
    requestedLines,
  };
}
