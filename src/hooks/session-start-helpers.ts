import type { Dirent } from "node:fs";
import { readFile as readFsFile, readdir as readFsDir, stat as statFs } from "node:fs/promises";
import { basename, join } from "node:path";
import { readRelationEntry } from "../retrieval/relations.js";
import { getConfidenceScore } from "../storage/confidence.js";
import { parseFrontmatter } from "../storage/frontmatter.js";
import { indexPath, memoryRoot as defaultMemoryRoot } from "../storage/paths.js";

export interface ConfidenceAwareIndexOptions {
  indexFilePath?: string;
  memoryRoot?: string;
  readFile?: (path: string) => Promise<string>;
}

export interface WhatToRememberOptions {
  memoryRoot?: string;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  maxPreferences?: number;
  maxRecent?: number;
  maxChars?: number;
}

export interface ResolveProjectForCwdOptions {
  memoryRoot?: string;
  readFile?: (path: string) => Promise<string>;
  readdir?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  maxProjectPages?: number;
}

export interface CurrentProjectMemoryOptions extends ResolveProjectForCwdOptions {
  cwd?: string | null;
  maxChars?: number;
}

interface BucketedEntry {
  confidence: number;
  line: string;
}

interface RememberEntry {
  path: string;
  text: string;
  confidence: number;
  timestamp?: string;
  sortKey?: number;
  tags?: string[];
}

const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_MAX_PREFERENCES = 8;
const DEFAULT_MAX_RECENT = 10;
const DEFAULT_EXCERPT_CHARS = 280;
export const MAX_INJECTED_CHARS = 8000;
const MAX_PROJECT_PAGE_SCAN = 500;
const RELATED_MEMORY_LIMIT = 5;
const PROJECT_TRUNCATION_MARKER = "\n(truncated, use MCP read_page for full)";
const IGNORED_CWD_SEGMENTS = new Set(["src", ".claude", "worktrees", "node_modules"]);
const WIKI_CATEGORIES = new Set([
  "projects",
  "people",
  "decisions",
  "lessons",
  "references",
  "tools",
  "threads",
  "procedures",
  "prospective",
]);

interface ProjectPageCandidate {
  slug: string;
  relPath: string;
  fullPath: string;
}

interface IndexEntry {
  path: string;
  title: string;
  summary: string;
}

interface RelatedEntry extends IndexEntry {
  strength: number;
  recency: number;
}

export async function resolveProjectForCwd(
  cwd: string | null | undefined,
  opts: ResolveProjectForCwdOptions = {},
): Promise<string | null> {
  if (typeof cwd !== "string" || cwd.trim().length === 0) return null;
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const readFile = opts.readFile ?? ((path: string) => readFsFile(path, "utf-8"));
  const projects = await listProjectCandidates(root, opts.readdir ?? readFsDir, opts.maxProjectPages);
  if (projects.length === 0) return null;

  const cwdKey = normalizeMatchPath(cwd);
  const repoMatches: Array<{ relPath: string; length: number }> = [];
  for (const project of projects) {
    let content: string;
    try {
      content = await readFile(project.fullPath);
    } catch {
      continue;
    }
    const { frontmatter } = parseFrontmatter(content);
    for (const repoPath of readRepoPaths(frontmatter)) {
      const repoKey = normalizeMatchPath(repoPath);
      if (repoKey.length === 0) continue;
      if (cwdKey === repoKey || cwdKey.startsWith(`${repoKey}/`)) {
        repoMatches.push({ relPath: project.relPath, length: repoKey.length });
      }
    }
  }

  const bestRepoLength = Math.max(0, ...repoMatches.map((match) => match.length));
  if (bestRepoLength > 0) {
    const winners = [...new Set(repoMatches
      .filter((match) => match.length === bestRepoLength)
      .map((match) => match.relPath))];
    return winners.length === 1 ? winners[0]! : null;
  }

  const segments = cwdKey.split("/").filter((segment) => segment.length > 0);
  const slugMatches: Array<{ relPath: string; depth: number }> = [];
  for (const project of projects) {
    const slug = project.slug.toLowerCase();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      if (IGNORED_CWD_SEGMENTS.has(segment)) continue;
      if (segment === slug) slugMatches.push({ relPath: project.relPath, depth: index });
    }
  }

  const deepest = Math.max(-1, ...slugMatches.map((match) => match.depth));
  if (deepest < 0) return null;
  const winners = [...new Set(slugMatches
    .filter((match) => match.depth === deepest)
    .map((match) => match.relPath))];
  return winners.length === 1 ? winners[0]! : null;
}

export async function currentProjectMemoryBlock(
  opts: CurrentProjectMemoryOptions = {},
): Promise<string | null> {
  const maxChars = opts.maxChars ?? MAX_INJECTED_CHARS;
  if (maxChars <= 0) return "";
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const readFile = opts.readFile ?? ((path: string) => readFsFile(path, "utf-8"));
  const projectRelPath = await resolveProjectForCwd(opts.cwd, {
    memoryRoot: root,
    readFile,
    readdir: opts.readdir,
    maxProjectPages: opts.maxProjectPages,
  });
  if (!projectRelPath) return null;

  const projectContent = await readFile(join(root, ...projectRelPath.split("/")));
  const { frontmatter, body } = parseFrontmatter(projectContent);
  const indexEntries = await readIndexEntries(root, readFile);
  const related = await collectRelatedEntries({
    root,
    readFile,
    projectRelPath,
    frontmatter,
    body,
    indexEntries,
  });

  const block = [
    formatCurrentProjectSection(projectRelPath, frontmatter, body),
    formatRelatedMemorySection(related),
  ].join("\n");

  return truncateWithMarker(block, maxChars);
}

async function listProjectCandidates(
  root: string,
  readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>,
  maxProjectPages = MAX_PROJECT_PAGE_SCAN,
): Promise<ProjectPageCandidate[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, "wiki", "projects"), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxProjectPages)
    .map((entry) => {
      const slug = basename(entry.name, ".md");
      const relPath = `wiki/projects/${entry.name}`;
      return {
        slug,
        relPath,
        fullPath: join(root, "wiki", "projects", entry.name),
      };
    });
}

function readRepoPaths(frontmatter: Record<string, unknown>): string[] {
  const repo = frontmatter["repo"];
  const repoPaths = frontmatter["repo_paths"];
  const paths: string[] = [];
  if (typeof repo === "string" && repo.trim().length > 0) paths.push(repo);
  if (Array.isArray(repoPaths)) {
    for (const value of repoPaths) {
      if (typeof value === "string" && value.trim().length > 0) paths.push(value);
    }
  }
  return paths;
}

function normalizeMatchPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

async function readIndexEntries(
  root: string,
  readFile: (path: string) => Promise<string>,
): Promise<IndexEntry[]> {
  try {
    return parseIndexEntries(await readFile(join(root, "index.md")));
  } catch {
    return [];
  }
}

function parseIndexEntries(indexContent: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const line of indexContent.split(/\r?\n/)) {
    const markdown = line.match(/^-\s+\[([^\]]+)\]\(([^)#]+)(?:#[^)]+)?\)\s+-\s*(.*)$/);
    if (markdown) {
      const path = normalizeReferencePath(markdown[2]!);
      if (path) {
        entries.push({
          title: markdown[1]!.trim(),
          path,
          summary: markdown[3]!.trim(),
        });
      }
      continue;
    }

    const wiki = line.match(/^-\s+\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]\s*(?:-\s*)?(.*)$/);
    if (wiki) {
      const path = normalizeReferencePath(wiki[1]!);
      if (path) {
        const title = (wiki[2] ?? titleFromRelPath(path)).trim();
        const summary = wiki[3]!.trim() || title;
        entries.push({ title, path, summary });
      }
    }
  }
  return entries;
}

async function collectRelatedEntries(input: {
  root: string;
  readFile: (path: string) => Promise<string>;
  projectRelPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  indexEntries: IndexEntry[];
}): Promise<RelatedEntry[]> {
  const indexByPath = new Map(input.indexEntries.map((entry) => [entry.path, entry]));
  const indexBySlug = buildIndexBySlug(input.indexEntries);
  const candidates = [
    ...relationTargets(input.frontmatter["relations"]),
    ...wikilinkTargets(input.body),
  ];
  const seen = new Set<string>();
  const related: RelatedEntry[] = [];

  for (const candidate of candidates) {
    const relPath = resolveMemoryReference(candidate, indexBySlug);
    if (!relPath || relPath === input.projectRelPath || seen.has(relPath)) continue;
    seen.add(relPath);

    const indexEntry = indexByPath.get(relPath) ?? {
      path: relPath,
      title: titleFromRelPath(relPath),
      summary: titleFromRelPath(relPath),
    };
    const meta = await readRelatedMetadata(input.root, input.readFile, relPath);
    related.push({
      ...indexEntry,
      strength: meta.strength,
      recency: meta.recency,
    });
  }

  return related.sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.recency !== a.recency) return b.recency - a.recency;
    return a.title.localeCompare(b.title) || a.path.localeCompare(b.path);
  });
}

function relationTargets(relations: unknown): string[] {
  if (typeof relations !== "object" || relations === null || Array.isArray(relations)) return [];
  const targets: string[] = [];
  for (const value of Object.values(relations as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const target = readRelationEntry(entry)?.target;
      if (target) targets.push(target);
    }
  }
  return targets;
}

function wikilinkTargets(body: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (const match of body.matchAll(re)) {
    targets.push(match[1]!);
  }
  return targets;
}

function buildIndexBySlug(entries: IndexEntry[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const entry of entries) {
    const slug = basename(entry.path, ".md").toLowerCase();
    if (result.has(slug)) result.set(slug, null);
    else result.set(slug, entry.path);
  }
  return result;
}

function resolveMemoryReference(
  value: string,
  indexBySlug: Map<string, string | null>,
): string | null {
  const normalized = normalizeReferencePath(value);
  if (!normalized) return null;
  if (normalized.includes("/")) return normalized;
  return indexBySlug.get(normalized.toLowerCase()) ?? null;
}

function normalizeReferencePath(value: string): string | null {
  let normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/#.*$/, "");
  if (normalized.length === 0) return null;
  if (!normalized.endsWith(".md") && normalized.includes("/")) normalized = `${normalized}.md`;
  const firstSegment = normalized.split("/")[0];
  if (firstSegment && WIKI_CATEGORIES.has(firstSegment)) {
    return `wiki/${normalized}`;
  }
  if (normalized.startsWith("wiki/") || normalized.startsWith("crystals/")) {
    return normalized;
  }
  return normalized;
}

async function readRelatedMetadata(
  root: string,
  readFile: (path: string) => Promise<string>,
  relPath: string,
): Promise<{ strength: number; recency: number }> {
  try {
    const { frontmatter } = parseFrontmatter(await readFile(join(root, ...relPath.split("/"))));
    const strength = typeof frontmatter["strength"] === "number" && Number.isFinite(frontmatter["strength"])
      ? frontmatter["strength"]
      : 0;
    const recency = timestampToSortKey(String(frontmatter["last_accessed"] ?? frontmatter["updated"] ?? "")) ?? 0;
    return { strength, recency };
  } catch {
    return { strength: 0, recency: 0 };
  }
}

function formatCurrentProjectSection(
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const meta: string[] = [];
  if (typeof frontmatter["title"] === "string") meta.push(`title: ${frontmatter["title"]}`);
  if (typeof frontmatter["status"] === "string") meta.push(`status: ${frontmatter["status"]}`);
  if (typeof frontmatter["updated"] === "string") meta.push(`updated: ${frontmatter["updated"]}`);
  return [
    `--- Current project memory (${relPath}) ---`,
    meta.join("\n"),
    "",
    body.trim(),
    "",
  ].join("\n");
}

function formatRelatedMemorySection(entries: RelatedEntry[]): string {
  const lines = ["--- Related memory ---"];
  if (entries.length === 0) {
    lines.push("(none found)");
    return `${lines.join("\n")}\n`;
  }

  const top = entries.slice(0, RELATED_MEMORY_LIMIT);
  const rest = entries.slice(RELATED_MEMORY_LIMIT);
  lines.push(...top.map((entry) => `- ${entry.title} (${entry.path}): ${entry.summary}`));
  if (rest.length > 0) {
    lines.push("more:");
    lines.push(...rest.map((entry) => `- ${entry.title}`));
  }
  return `${lines.join("\n")}\n`;
}

function titleFromRelPath(relPath: string): string {
  return basename(relPath, ".md")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= PROJECT_TRUNCATION_MARKER.length) {
    return PROJECT_TRUNCATION_MARKER.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - PROJECT_TRUNCATION_MARKER.length).trimEnd()}${PROJECT_TRUNCATION_MARKER}`;
}

export async function confidenceAwareIndex(
  opts: ConfidenceAwareIndexOptions = {},
): Promise<string> {
  const readFile =
    opts.readFile ?? ((path: string) => readFsFile(path, "utf-8"));
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const indexFile = opts.indexFilePath ?? indexPath();
  const indexContent = await readFile(indexFile);
  const floor = injectionConfidenceFloor();
  const buckets = {
    high: [] as BucketedEntry[],
    medium: [] as BucketedEntry[],
    low: [] as BucketedEntry[],
  };

  for (const line of indexContent.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const confidence = await confidenceForIndexLine(line, { readFile, root });
    if (confidence < floor) continue;
    if (confidence >= 0.8) buckets.high.push({ confidence, line });
    else if (confidence >= 0.5) buckets.medium.push({ confidence, line });
    else buckets.low.push({ confidence, line });
  }

  return formatBuckets(buckets, floor);
}

export async function whatToRememberBlock(
  opts: WhatToRememberOptions = {},
): Promise<string> {
  const root = opts.memoryRoot ?? defaultMemoryRoot();
  const readFile = opts.readFile ?? ((path: string) => readFsFile(path, "utf-8"));
  const readdir = opts.readdir ?? readFsDir;
  const maxPreferences = opts.maxPreferences ?? DEFAULT_MAX_PREFERENCES;
  const maxRecent = opts.maxRecent ?? DEFAULT_MAX_RECENT;
  const maxChars = opts.maxChars ?? DEFAULT_EXCERPT_CHARS;
  const floor = injectionConfidenceFloor();
  const recentFloor = Math.max(floor, 0.7);

  const [wikiPreferences, rawObservations] = await Promise.all([
    collectPreferencePages({ root, readFile, readdir, maxChars, floor }),
    collectRawObservations({ root, readFile, readdir, maxChars }),
  ]);

  const preferenceObservations = rawObservations.filter((entry) =>
    entry.tags?.includes("preference") && entry.confidence >= floor
  );
  const recentObservations = rawObservations.filter((entry) =>
    !entry.tags?.includes("preference") && entry.confidence >= recentFloor
  );

  const preferences = [
    ...wikiPreferences.sort(compareRememberEntries).slice(0, maxPreferences),
    ...preferenceObservations.sort(compareRememberEntries).slice(0, maxPreferences),
  ];
  const recent = recentObservations
    .sort(compareRememberEntries)
    .slice(0, maxRecent);

  if (preferences.length === 0 && recent.length === 0) return "";

  const sections = ["--- What you should remember ---"];
  if (preferences.length > 0) {
    sections.push(
      "Preferences / durable directives:",
      ...preferences.map((entry) => formatRememberEntry(entry)),
    );
  }
  if (recent.length > 0) {
    sections.push(
      "Recent high-confidence observations:",
      ...recent.map((entry) => formatRememberEntry(entry)),
    );
  }
  return `${sections.join("\n")}\n`;
}

async function confidenceForIndexLine(
  line: string,
  deps: { readFile: (path: string) => Promise<string>; root: string },
): Promise<number> {
  const relPath = extractIndexedPagePath(line);
  if (!relPath) return DEFAULT_CONFIDENCE;

  try {
    const content = await deps.readFile(join(deps.root, relPath));
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter.confidence === undefined
      ? DEFAULT_CONFIDENCE
      : getConfidenceScore(frontmatter.confidence, DEFAULT_CONFIDENCE);
  } catch {
    return DEFAULT_CONFIDENCE;
  }
}

function extractIndexedPagePath(line: string): string | null {
  const wikiLink = line.match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/);
  const markdownLink = line.match(/\]\(([^)#]+)(?:#[^)]+)?\)/);
  const barePath = line.match(
    /\b((?:wiki|crystals|projects|people|decisions|lessons|references|tools)\/[^\s)`]+(?:\.md)?)\b/,
  );
  const rawPath = wikiLink?.[1] ?? markdownLink?.[1] ?? barePath?.[1];
  if (!rawPath) return null;

  let normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  normalized = normalized.replace(/^\/+/, "").replace(/#.*$/, "");
  if (normalized.length === 0) return null;
  if (!normalized.endsWith(".md")) normalized = `${normalized}.md`;

  const firstSegment = normalized.split("/")[0];
  if (firstSegment && WIKI_CATEGORIES.has(firstSegment)) {
    return `wiki/${normalized}`;
  }
  if (normalized.startsWith("wiki/") || normalized.startsWith("crystals/")) {
    return normalized;
  }

  return null;
}

export function injectionConfidenceFloor(): number {
  const raw = process.env["MEMORY_FORT_INJECTION_CONF_FLOOR"];
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
}

async function collectPreferencePages(input: {
  root: string;
  readFile: (path: string) => Promise<string>;
  readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  maxChars: number;
  floor: number;
}): Promise<RememberEntry[]> {
  const results: RememberEntry[] = [];
  const preferencesPath = join(input.root, "wiki", "preferences.md");
  const explicit = await readWikiPreference(input, preferencesPath, "wiki/preferences.md", true);
  if (explicit) results.push(explicit);

  const files = await listMarkdownFiles(join(input.root, "wiki"), input.readdir, "wiki");
  for (const relPath of files) {
    if (relPath === "wiki/preferences.md") continue;
    const entry = await readWikiPreference(input, join(input.root, ...relPath.split("/")), relPath, false);
    if (entry) results.push(entry);
  }
  return results;
}

async function readWikiPreference(
  input: {
    readFile: (path: string) => Promise<string>;
    maxChars: number;
    floor: number;
  },
  path: string,
  relPath: string,
  alwaysSurface: boolean,
): Promise<RememberEntry | null> {
  try {
    const content = await input.readFile(path);
    const { frontmatter, body } = parseFrontmatter(content);
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
    if (!alwaysSurface && !tags.includes("preference")) return null;
    const confidence = frontmatter.confidence === undefined
      ? DEFAULT_CONFIDENCE
      : getConfidenceScore(frontmatter.confidence, DEFAULT_CONFIDENCE);
    if (!alwaysSurface && confidence < input.floor) return null;
    const title = String(frontmatter.title ?? relPath);
    return {
      path: relPath,
      text: `${title}: ${excerpt(body, input.maxChars)}`,
      confidence,
      tags,
      timestamp: String(frontmatter.updated ?? frontmatter.created ?? ""),
      sortKey: timestampToSortKey(String(frontmatter.updated ?? frontmatter.created ?? "")),
    };
  } catch {
    return null;
  }
}

async function collectRawObservations(input: {
  root: string;
  readFile: (path: string) => Promise<string>;
  readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  maxChars: number;
}): Promise<RememberEntry[]> {
  const rawFiles = await listMarkdownFiles(join(input.root, "raw"), input.readdir, "raw");
  const entries: RememberEntry[] = [];
  for (const relPath of rawFiles) {
    let content: string;
    try {
      content = await input.readFile(join(input.root, ...relPath.split("/")));
    } catch {
      continue;
    }
    const date = relPath.split("/")[1] ?? "";
    let mtime: Date | null = null;
    try {
      mtime = (await statFs(join(input.root, ...relPath.split("/")))).mtime;
    } catch {
      // File mtime is only a fallback for older observation blocks.
    }
    entries.push(...parseObservationBlocks(content, relPath, date, input.maxChars, mtime));
  }
  return entries;
}

async function listMarkdownFiles(
  dir: string,
  readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>,
  prefix: string,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${prefix}/${entry.name}`.replace(/\\/g, "/");
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(full, readdir, rel));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(rel);
    }
  }
  return files;
}

function parseObservationBlocks(
  content: string,
  relPath: string,
  date: string,
  maxChars: number,
  fileMtime: Date | null = null,
): RememberEntry[] {
  const entries: RememberEntry[] = [];
  const starts = [...content.matchAll(/^##(?: \[([^\]]+)\])? Observation[ \t]*\r?$/gm)];
  for (let index = 0; index < starts.length; index += 1) {
    const match = starts[index]!;
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = starts[index + 1]?.index ?? content.length;
    const time = match[1];
    const rawBody = content.slice(bodyStart, bodyEnd).trim();
    const metaMatch = /^_([^\n]+)_\s*\n+/.exec(rawBody);
    const meta = metaMatch?.[1] ?? "";
    const body = metaMatch ? rawBody.slice(metaMatch[0].length).trim() : rawBody;
    const tags = parseObservationTags(meta);
    const confidence = parseObservationConfidence(meta) ?? DEFAULT_CONFIDENCE;
    const timestamp = parseObservationObservedAt(meta) ?? timestampFromDateAndTime(date, time) ?? fileMtime?.toISOString() ?? `${date}T00:00:00.000Z`;
    if (body.length === 0) continue;
    entries.push({
      path: relPath,
      text: excerpt(body, maxChars),
      confidence,
      timestamp,
      sortKey: timestampToSortKey(timestamp) ?? fileMtime?.getTime() ?? timestampToSortKey(date) ?? 0,
      tags,
    });
  }
  return entries;
}

function parseObservationTags(meta: string): string[] {
  const match = /(?:^|·)\s*tags:\s*([^·]+)/.exec(meta);
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function parseObservationConfidence(meta: string): number | null {
  const match = /(?:^|·)\s*confidence:\s*([0-9.]+)/.exec(meta);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function parseObservationObservedAt(meta: string): string | null {
  const match = /(?:^|·)\s*observed_at:\s*([^·]+)/.exec(meta);
  const value = match?.[1]?.trim();
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function timestampFromDateAndTime(date: string, time: string | undefined): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!time) return null;
  const parts = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!parts) return null;
  return `${date}T${parts[1]}:${parts[2]}:${parts[3] ?? "00"}.000Z`;
}

function timestampToSortKey(value: string): number | undefined {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareRememberEntries(a: RememberEntry, b: RememberEntry): number {
  const sortKey = (b.sortKey ?? 0) - (a.sortKey ?? 0);
  if (sortKey !== 0) return sortKey;
  const time = (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
  if (time !== 0) return time;
  return b.confidence - a.confidence;
}

function formatRememberEntry(entry: RememberEntry): string {
  const timestamp = entry.timestamp ? ` @ ${entry.timestamp}` : "";
  return `- ${entry.path}${timestamp} (confidence ${entry.confidence.toFixed(2)}): ${entry.text}`;
}

function excerpt(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatBuckets(
  buckets: {
    high: BucketedEntry[];
    medium: BucketedEntry[];
    low: BucketedEntry[];
  },
  floor: number,
): string {
  const sections: string[] = [];
  if (floor < 1 || buckets.high.length > 0) {
    sections.push(formatSection("High-confidence entries", buckets.high));
  }
  if (floor < 0.8 || buckets.medium.length > 0) {
    sections.push(formatSection("Medium-confidence entries", buckets.medium));
  }
  if (floor < 0.5 || buckets.low.length > 0) {
    sections.push(
      formatSection(
        "Low-confidence / drafts",
        buckets.low.map((entry) => ({
          ...entry,
          line: `⚠ DRAFT: ${entry.line}`,
        })),
      ),
    );
  }
  return sections.join("\n\n");
}

function formatSection(label: string, entries: BucketedEntry[]): string {
  return `--- ${label} (${entries.length}) ---\n${entries
    .map((entry) => entry.line)
    .join("\n")}`;
}
