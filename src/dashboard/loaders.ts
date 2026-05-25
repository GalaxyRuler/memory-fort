import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  checkSupersededDependents,
  loadWiki as loadCurationWiki,
} from "../curation/checks.js";
import { loadSearchCorpus, type SearchScope } from "../retrieval/corpus.js";
import { buildGraph } from "../retrieval/graph.js";
import { loadMemoryConfig } from "../storage/config.js";
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
    lastCheckoutAt?: string | null;
    isStale?: boolean;
  } | null;
  generatedAt: string;
}

export type RunGit = (opts: { cwd: string; args: string[] }) => Promise<string>;

const execFileAsync = promisify(execFile);
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const LOG_HEADING_RE = /^## \[([^\]]+)\] ([A-Za-z0-9_-]+) \| (.*)$/;
const CHECKOUT_SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const TIMELINE_LANES = [
  "claude-code",
  "codex",
  "antigravity",
  "manual",
  "compile",
  "lint",
  "sync",
] as const;
const TIMELINE_COLORS: Record<(typeof TIMELINE_LANES)[number], string> = {
  "claude-code": "#8b5fff",
  codex: "#5b8bff",
  antigravity: "#cebdff",
  manual: "#94a3b8",
  compile: "#22c55e",
  lint: "#f59e0b",
  sync: "#38bdf8",
};
const TIMELINE_BUCKET_MS: Record<TimelineZoom, number> = {
  "1H": 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
  "1Y": 365 * 24 * 60 * 60 * 1000,
};

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

export type RawSessionSource = "claude-code" | "codex" | "antigravity" | "manual" | "unknown";

export interface RawSessionDetail {
  date: string;
  filename: string;
  fullPath: string;
  source: RawSessionSource;
  sessionId: string;
  sizeBytes: number;
  mtime: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface LogTail {
  lines: string[];
  totalLines: number;
  requestedLines: number;
}

export type ActivitySource = "git" | "compile" | "sync" | "lint" | "errors";
export type ActivityLevel = "info" | "warn" | "error";

export interface ActivityEvent {
  timestamp: string;
  source: ActivitySource;
  level: ActivityLevel;
  summary: string;
  details?: Record<string, unknown>;
}

export interface ActivityFeed {
  events: ActivityEvent[];
  nextCursor: string | null;
}

export type TimelineZoom = "1H" | "1D" | "1W" | "1M" | "1Y";

export interface TimelineLaneEvent {
  timestamp: string;
  summary: string;
  entity_color: string;
}

export interface TimelineFeed {
  from: string;
  to: string;
  zoom: TimelineZoom;
  lanes: Array<{ lane: string; events: TimelineLaneEvent[] }>;
  velocity: Array<{ bucket: string; count: number }>;
}

export interface GraphFeed {
  nodes: Array<{
    path: string;
    title: string;
    kind: "wiki" | "raw" | "crystal";
    type: string;
    confidence: number | null;
    updated: string | null;
    inboundCount: number;
    outboundCount: number;
  }>;
  edges: Array<{
    fromPath: string;
    toPath: string;
    kind: "relation" | "wikilink";
    relationType: string | null;
  }>;
  unresolvedTargets: Array<{ fromPath: string; raw: string; reason: string }>;
}

export interface CheckoutSyncState {
  lastCheckoutAt: string | null;
  lastCommit: string | null;
  status: "synced" | "stale" | "unknown";
}

export type CompileStatus = "idle" | "running" | "completed" | "failed";

export interface CompileLastRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pagesCompiled: number;
  digestPath: string;
}

export interface CompileState {
  status: CompileStatus;
  lastRun: CompileLastRun | null;
}

export type ConflictReason =
  | "duplicate-title"
  | "contradiction"
  | "stale-clone"
  | "derived-from-contradiction";

export interface ConflictPageSummary {
  path: string;
  title: string;
  updated: string | null;
  snippet: string;
}

export interface DirectConflictRecord {
  id: string;
  pageA: ConflictPageSummary;
  pageB: ConflictPageSummary;
  reason: Exclude<ConflictReason, "derived-from-contradiction">;
}

export interface DerivedConflictRecord {
  id: string;
  reason: "derived-from-contradiction";
  dependentPath: string;
  via: string[];
  rootContradictionId: string;
}

export type ConflictRecord = DirectConflictRecord | DerivedConflictRecord;

export interface ConflictsResponse {
  conflicts: ConflictRecord[];
}

export interface MaintenancePageSummary {
  path: string;
  title: string;
  updated: string | null;
  confidence: number | null;
}

export interface MaintenanceScan {
  orphans: MaintenancePageSummary[];
  lowConfidence: MaintenancePageSummary[];
  stale: MaintenancePageSummary[];
  supersededDependents: MaintenancePageSummary[];
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
  const clean = target
    .trim()
    .split("|")[0]!
    .split("#")[0]!
    .replace(/^wiki\//, "")
    .replace(/\.md$/, "");
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
    const lastSyncAttempt = typeof parsed["last_sync_attempt"] === "string" ? parsed["last_sync_attempt"] : null;
    const lastSyncSuccess = typeof parsed["last_sync_success"] === "string" ? parsed["last_sync_success"] : null;
    const pendingPushCount = typeof parsed["pending_push_count"] === "number" ? parsed["pending_push_count"] : 0;
    const conflictsPending = typeof parsed["conflicts_pending"] === "number" ? parsed["conflicts_pending"] : 0;
    const lastCheckoutAt =
      typeof parsed["last_checkout_at"] === "string"
        ? parsed["last_checkout_at"]
        : lastSyncSuccess ?? lastSyncAttempt;
    return {
      lastSyncAttempt,
      lastSyncSuccess,
      pendingPushCount,
      conflictsPending,
      conflictFiles: Array.isArray(parsed["conflict_files"])
        ? parsed["conflict_files"].filter((value): value is string => typeof value === "string")
        : [],
      lastCheckoutAt,
      isStale:
        typeof parsed["is_stale"] === "boolean"
          ? parsed["is_stale"]
          : pendingPushCount > 0,
    };
  } catch (err) {
    console.warn(`dashboard: unable to read sync state: ${(err as Error).message}`);
    return null;
  }
}

const COMPILE_STATUSES = new Set<CompileStatus>(["idle", "running", "completed", "failed"]);
const DIRECT_CONFLICT_REASONS = new Set<DirectConflictRecord["reason"]>([
  "duplicate-title",
  "contradiction",
  "stale-clone",
]);

function parseCompileStatus(value: unknown): CompileStatus {
  return typeof value === "string" && COMPILE_STATUSES.has(value as CompileStatus)
    ? (value as CompileStatus)
    : "idle";
}

function parseCompileLastRun(value: unknown): CompileLastRun | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const startedAt = record["startedAt"];
  const finishedAt = record["finishedAt"];
  const durationMs = record["durationMs"];
  const pagesCompiled = record["pagesCompiled"];
  const digestPath = record["digestPath"];
  if (
    typeof startedAt !== "string" ||
    typeof finishedAt !== "string" ||
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    typeof pagesCompiled !== "number" ||
    !Number.isFinite(pagesCompiled) ||
    typeof digestPath !== "string"
  ) {
    return null;
  }

  return { startedAt, finishedAt, durationMs, pagesCompiled, digestPath };
}

export async function loadCompileState(vaultRoot: string): Promise<CompileState> {
  const candidates = [
    join(vaultRoot, "state", "compile-state.json"),
    join(vaultRoot, "state", "compile.json"),
    join(vaultRoot, ".compile-state.json"),
  ];

  for (const path of candidates) {
    if (!(await pathExists(path))) continue;
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
      return {
        status: parseCompileStatus(parsed["status"]),
        lastRun: parseCompileLastRun(parsed["lastRun"] ?? parsed["last_run"]),
      };
    } catch (err) {
      console.warn(`dashboard: unable to read compile state: ${(err as Error).message}`);
      return { status: "idle", lastRun: null };
    }
  }

  return { status: "idle", lastRun: null };
}

function parseConflictPageSummary(value: unknown): ConflictPageSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const path = record["path"];
  const title = record["title"];
  const updated = record["updated"];
  const snippet = record["snippet"];
  if (
    typeof path !== "string" ||
    typeof title !== "string" ||
    !(typeof updated === "string" || updated === null || updated === undefined) ||
    typeof snippet !== "string"
  ) {
    return null;
  }
  return { path, title, updated: updated ?? null, snippet: snippet.slice(0, 200) };
}

function parseConflictRecord(value: unknown): ConflictRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const reason = record["reason"];
  if (reason === "derived-from-contradiction") {
    const dependentPath = record["dependentPath"];
    const via = record["via"];
    const rootContradictionId = record["rootContradictionId"];
    if (
      typeof id !== "string" ||
      typeof dependentPath !== "string" ||
      !Array.isArray(via) ||
      !via.every((item) => typeof item === "string") ||
      typeof rootContradictionId !== "string"
    ) {
      return null;
    }
    return { id, reason, dependentPath, via, rootContradictionId };
  }

  const pageA = parseConflictPageSummary(record["pageA"]);
  const pageB = parseConflictPageSummary(record["pageB"]);
  if (
    typeof id !== "string" ||
    typeof reason !== "string" ||
    !DIRECT_CONFLICT_REASONS.has(reason as DirectConflictRecord["reason"]) ||
    !pageA ||
    !pageB
  ) {
    return null;
  }
  return { id, reason: reason as DirectConflictRecord["reason"], pageA, pageB };
}

export async function loadConflicts(vaultRoot: string): Promise<ConflictsResponse> {
  const candidates = [
    join(vaultRoot, "state", "conflicts.json"),
    join(vaultRoot, ".conflicts.json"),
  ];

  for (const path of candidates) {
    if (!(await pathExists(path))) continue;
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
      const rawConflicts =
        Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["conflicts"])
            ? ((parsed as Record<string, unknown>)["conflicts"] as unknown[])
            : [];
      return {
        conflicts: rawConflicts
          .map(parseConflictRecord)
          .filter((item): item is ConflictRecord => item !== null),
      };
    } catch (err) {
      console.warn(`dashboard: unable to read conflict store: ${(err as Error).message}`);
      return { conflicts: [] };
    }
  }

  return { conflicts: [] };
}

function pageSummary(page: WikiPage): MaintenancePageSummary {
  const title = readTitle(page) ?? page.path;
  const updated = typeof page.frontmatter.updated === "string" ? page.frontmatter.updated : null;
  const confidence = typeof page.frontmatter.confidence === "number" ? page.frontmatter.confidence : null;
  return { path: `wiki/${page.path}`, title, updated, confidence };
}

function collectOutbound(page: WikiPage, idx: ResolutionIndex): Set<string> {
  const outbound = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(page.body)) !== null) {
    const resolved = resolveLink(match[1]!, idx);
    if (resolved) outbound.add(resolved.path);
  }

  const relations = page.frontmatter.relations;
  if (!relations || typeof relations !== "object") return outbound;
  for (const targets of Object.values(relations)) {
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const resolved = resolveLink(target, idx);
      if (resolved) outbound.add(resolved.path);
    }
  }
  return outbound;
}

export async function loadMaintenanceScan(vaultRoot: string, now: Date = new Date()): Promise<MaintenanceScan> {
  const pages = await loadCurationWiki(join(vaultRoot, "wiki"));
  const idx = buildResolutionIndex(pages);
  const inbound = new Map<string, Set<string>>();
  const outboundByPath = new Map<string, Set<string>>();

  for (const page of pages) {
    const outbound = collectOutbound(page, idx);
    outboundByPath.set(page.path, outbound);
    for (const targetPath of outbound) {
      if (!inbound.has(targetPath)) inbound.set(targetPath, new Set());
      inbound.get(targetPath)!.add(page.path);
    }
  }

  const staleCutoff = now.getTime() - 180 * 24 * 60 * 60 * 1000;
  const orphans: MaintenancePageSummary[] = [];
  const lowConfidence: MaintenancePageSummary[] = [];
  const stale: MaintenancePageSummary[] = [];
  const supersededDependentPaths = new Set(
    checkSupersededDependents(pages).map((issue) => issue.page.replace(/^wiki\//, "")),
  );
  const supersededDependents: MaintenancePageSummary[] = [];

  for (const page of pages) {
    const outbound = outboundByPath.get(page.path);
    if ((inbound.get(page.path)?.size ?? 0) === 0 && (!outbound || outbound.size === 0)) {
      orphans.push(pageSummary(page));
    }

    if (typeof page.frontmatter.confidence === "number" && page.frontmatter.confidence < 0.6) {
      lowConfidence.push(pageSummary(page));
    }

    if (typeof page.frontmatter.updated === "string") {
      const updatedAt = Date.parse(page.frontmatter.updated);
      if (Number.isFinite(updatedAt) && updatedAt < staleCutoff) {
        stale.push(pageSummary(page));
      }
    }

    if (supersededDependentPaths.has(page.path)) {
      supersededDependents.push(pageSummary(page));
    }
  }

  const byPath = (a: MaintenancePageSummary, b: MaintenancePageSummary) => a.path.localeCompare(b.path);
  return {
    orphans: orphans.sort(byPath),
    lowConfidence: lowConfidence.sort(byPath),
    stale: stale.sort(byPath),
    supersededDependents: supersededDependents.sort(byPath),
  };
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

function parseRawSourceFromFilename(filename: string): RawSessionSource {
  if (filename.startsWith("claude-code-")) return "claude-code";
  if (filename.startsWith("codex-")) return "codex";
  if (filename.startsWith("antigravity-")) return "antigravity";
  if (filename.startsWith("manual-mcp-") || filename.startsWith("manual-")) return "manual";
  return "unknown";
}

function parseRawSessionIdFromFilename(filename: string): string {
  const noExt = filename.replace(/\.md$/, "");
  const prefixes = ["claude-code-", "codex-", "antigravity-", "manual-mcp-", "manual-"];
  for (const prefix of prefixes) {
    if (noExt.startsWith(prefix)) return noExt.slice(prefix.length);
  }
  return noExt;
}

export async function loadRawSessionDetail(
  vaultRoot: string,
  date: string,
  filename: string,
): Promise<RawSessionDetail | null> {
  const rawRoot = join(vaultRoot, "raw");
  const fullPath = safeResolveUnder(rawRoot, date, filename);
  if (!fullPath || !(await pathExists(fullPath))) return null;
  const info = await stat(fullPath);
  if (!info.isFile()) return null;

  const content = await readFile(fullPath, "utf-8");
  const parsed = parseWikiMarkdown(content);
  return {
    date,
    filename,
    fullPath,
    source: parseRawSourceFromFilename(filename),
    sessionId: parseRawSessionIdFromFilename(filename),
    sizeBytes: info.size,
    mtime: info.mtime.toISOString(),
    body: parsed.body,
    frontmatter: parsed.frontmatter as Record<string, unknown>,
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

export async function loadActivityEvents(
  vaultRoot: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<ActivityFeed> {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const cursorTime = opts.cursor ? Date.parse(opts.cursor) : Number.POSITIVE_INFINITY;
  const allEvents = [
    ...(await loadGitActivityEvents(vaultRoot)),
    ...(await loadLogActivityEvents(vaultRoot)),
    ...(await loadCheckoutActivityEvents(vaultRoot)),
    ...(await loadErrorActivityEvents(vaultRoot)),
  ]
    .filter((event) => Date.parse(event.timestamp) < cursorTime)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.summary.localeCompare(b.summary));

  const events = allEvents.slice(0, limit);
  return {
    events,
    nextCursor: events.at(-1)?.timestamp ?? null,
  };
}

export async function loadTimelineFeed(
  vaultRoot: string,
  opts: { from: Date; to: Date; zoom: TimelineZoom },
): Promise<TimelineFeed> {
  const allEvents = await loadActivityEvents(vaultRoot, { limit: 200 });
  const fromMs = opts.from.getTime();
  const toMs = opts.to.getTime();
  const visibleEvents = allEvents.events.filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    return timestamp >= fromMs && timestamp <= toMs;
  });

  const lanes = TIMELINE_LANES.map((lane) => ({
    lane,
    events: visibleEvents
      .filter((event) => timelineLaneForEvent(event) === lane)
      .map((event) => ({
        timestamp: event.timestamp,
        summary: event.summary,
        entity_color: TIMELINE_COLORS[lane],
      })),
  }));

  const bucketMs = TIMELINE_BUCKET_MS[opts.zoom];
  const velocity: TimelineFeed["velocity"] = [];
  for (let bucket = fromMs; bucket <= toMs; bucket += bucketMs) {
    const nextBucket = bucket + bucketMs;
    velocity.push({
      bucket: new Date(bucket).toISOString(),
      count: visibleEvents.filter((event) => {
        const timestamp = Date.parse(event.timestamp);
        return timestamp >= bucket && timestamp < nextBucket;
      }).length,
    });
  }

  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    zoom: opts.zoom,
    lanes,
    velocity,
  };
}

export async function loadGraphFeed(vaultRoot: string, scope: SearchScope = "wiki"): Promise<GraphFeed> {
  const corpus = await loadSearchCorpus({ vaultRoot, scope });
  const graph = buildGraph(corpus.documents);
  const docsByPath = new Map(corpus.documents.map((document) => [document.relPath, document]));

  const nodes = [...graph.nodes.values()]
    .map((node) => {
      const document = docsByPath.get(node.path);
      return {
        path: node.path,
        title: document?.title ?? node.path,
        kind: document?.kind ?? "wiki",
        type: document?.type ?? "unknown",
        confidence: document?.confidence ?? null,
        updated: document?.updated ?? null,
        inboundCount: node.inbound.length,
        outboundCount: node.outbound.length,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    nodes,
    edges: graph.edges,
    unresolvedTargets: graph.unresolvedTargets,
  };
}

export async function loadCheckoutSyncState(vaultRoot: string, now: Date = new Date()): Promise<CheckoutSyncState> {
  const checkoutPath = await findCheckoutLogPath(vaultRoot);
  if (!checkoutPath) {
    return { lastCheckoutAt: null, lastCommit: null, status: "unknown" };
  }

  const content = await readFile(checkoutPath, "utf-8");
  const lastLine = content.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1);
  if (!lastLine) {
    return { lastCheckoutAt: null, lastCommit: null, status: "unknown" };
  }

  const timestamp = parseIsoFromText(lastLine);
  if (!timestamp) {
    return { lastCheckoutAt: null, lastCommit: null, status: "unknown" };
  }

  const ageMs = now.getTime() - Date.parse(timestamp);
  return {
    lastCheckoutAt: timestamp,
    lastCommit: CHECKOUT_SHA_RE.exec(lastLine)?.[0] ?? null,
    status: ageMs > 6 * 60 * 60 * 1000 ? "stale" : "synced",
  };
}

export async function loadRedactedConfig(vaultRoot: string): Promise<Record<string, unknown>> {
  return redactConfig(await loadMemoryConfig(vaultRoot)) as Record<string, unknown>;
}

async function loadGitActivityEvents(vaultRoot: string): Promise<ActivityEvent[]> {
  const args = ["log", "--format=%cI%x09%h%x09%s", "-n", "100"];
  let output = "";
  try {
    output = await defaultRunGit({ cwd: vaultRoot, args });
  } catch {
    try {
      output = await runBareRepoGit(vaultRoot, args);
    } catch {
      return [];
    }
  }

  return output
    .trimEnd()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .flatMap((line): ActivityEvent[] => {
      const [timestampRaw = "", sha = "", subject = ""] = line.split("\t");
      const timestamp = normalizeIso(timestampRaw);
      if (!timestamp) return [];
      return [{
        timestamp,
        source: "git",
        level: "info",
        summary: `${sha} ${subject}`.trim(),
        details: { sha },
      }];
    });
}

async function loadLogActivityEvents(vaultRoot: string): Promise<ActivityEvent[]> {
  const logPath = join(vaultRoot, "log.md");
  if (!(await pathExists(logPath))) return [];

  const events: ActivityEvent[] = [];
  for (const line of (await readFile(logPath, "utf-8")).split(/\r?\n/)) {
    const match = LOG_HEADING_RE.exec(line);
    if (!match) continue;
    const timestamp = normalizeIso(match[1]!);
    if (!timestamp) continue;
    events.push({
      timestamp,
      source: normalizeActivitySource(match[2]!),
      level: "info",
      summary: match[3]!.trim(),
    });
  }
  return events;
}

async function loadCheckoutActivityEvents(vaultRoot: string): Promise<ActivityEvent[]> {
  const checkoutPath = await findCheckoutLogPath(vaultRoot);
  if (!checkoutPath) return [];

  const events: ActivityEvent[] = [];
  for (const line of (await readFile(checkoutPath, "utf-8")).split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const timestamp = parseIsoFromText(line);
    if (!timestamp) continue;
    events.push({
      timestamp,
      source: "sync",
      level: "info",
      summary: line.replace(timestamp, "").trim() || "vault checkout",
      details: { sha: CHECKOUT_SHA_RE.exec(line)?.[0] ?? null },
    });
  }
  return events;
}

async function loadErrorActivityEvents(vaultRoot: string): Promise<ActivityEvent[]> {
  const errorsPath = join(vaultRoot, "errors.log");
  if (!(await pathExists(errorsPath))) return [];

  const info = await stat(errorsPath);
  if (info.size === 0) return [];
  const lines = (await readFile(errorsPath, "utf-8"))
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const latest = lines.at(-1);
  if (!latest) return [];
  return [{
    timestamp: info.mtime.toISOString(),
    source: "errors",
    level: "error",
    summary: latest.length > 180 ? `${latest.slice(0, 177)}...` : latest,
  }];
}

async function findCheckoutLogPath(vaultRoot: string): Promise<string | null> {
  const candidates = [
    join(dirname(vaultRoot), "logs", "checkout.log"),
    join(vaultRoot, "logs", "checkout.log"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

function normalizeActivitySource(source: string): ActivitySource {
  if (source === "compile" || source === "sync" || source === "lint") return source;
  if (source === "errors") return "errors";
  return "git";
}

function timelineLaneForEvent(event: ActivityEvent): (typeof TIMELINE_LANES)[number] {
  if (event.source === "compile" || event.source === "lint" || event.source === "sync") return event.source;
  return "manual";
}

function normalizeIso(value: string): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function parseIsoFromText(value: string): string | null {
  const match = /\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?/.exec(value);
  return match ? normalizeIso(match[0]!) : null;
}

function redactConfig(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactConfig(item, path));
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (path.length === 1 && path[0] === "voyage" && key === "api_key" && typeof child === "string" && child.length > 0) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactConfig(child, [...path, key]);
    }
  }
  return result;
}
