import type { Dirent } from "node:fs";
import { readFile as readFsFile, readdir as readFsDir } from "node:fs/promises";
import { join } from "node:path";
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

interface BucketedEntry {
  confidence: number;
  line: string;
}

interface RememberEntry {
  path: string;
  text: string;
  confidence: number;
  timestamp?: string;
  tags?: string[];
}

const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_MAX_PREFERENCES = 8;
const DEFAULT_MAX_RECENT = 10;
const DEFAULT_EXCERPT_CHARS = 280;
const WIKI_CATEGORIES = new Set([
  "projects",
  "people",
  "decisions",
  "lessons",
  "references",
  "tools",
]);

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

  const preferences = [...wikiPreferences, ...preferenceObservations]
    .sort(compareRememberEntries)
    .slice(0, maxPreferences);
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
    entries.push(...parseObservationBlocks(content, relPath, date, input.maxChars));
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
): RememberEntry[] {
  const entries: RememberEntry[] = [];
  const blockPattern = /^## \[(\d{2}:\d{2}:\d{2})\] Observation\s*\n([\s\S]*?)(?=^## \[|\z)/gm;
  for (const match of content.matchAll(blockPattern)) {
    const time = match[1] ?? "00:00:00";
    const rawBody = (match[2] ?? "").trim();
    const metaMatch = /^_([^_\n]+)_\s*\n+/.exec(rawBody);
    const meta = metaMatch?.[1] ?? "";
    const body = metaMatch ? rawBody.slice(metaMatch[0].length).trim() : rawBody;
    const tags = parseObservationTags(meta);
    const confidence = parseObservationConfidence(meta) ?? DEFAULT_CONFIDENCE;
    if (body.length === 0) continue;
    entries.push({
      path: relPath,
      text: excerpt(body, maxChars),
      confidence,
      timestamp: `${date}T${time}Z`,
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

function compareRememberEntries(a: RememberEntry, b: RememberEntry): number {
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
