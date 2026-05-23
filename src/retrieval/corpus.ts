import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { Frontmatter } from "../storage/frontmatter.js";

export type SearchScope = "wiki" | "raw" | "crystals" | "all";
export type SearchSource =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "manual"
  | "crystal"
  | "unknown";
export type SearchKind = "wiki" | "raw" | "crystal";

export interface SearchDocument {
  kind: SearchKind;
  relPath: string;
  fullPath: string;
  title: string;
  type: string;
  status: string;
  confidence: number | null;
  tags: string[];
  relations: Record<string, string[]>;
  source: SearchSource;
  session: string | null;
  body: string;
  snippetSource: string;
  mtime: string;
  sizeBytes: number;
}

export interface LoadCorpusOptions {
  vaultRoot: string;
  scope?: SearchScope;
}

export interface LoadCorpusResult {
  documents: SearchDocument[];
  errors: Array<{ path: string; reason: string }>;
  scannedCounts: {
    wiki: number;
    raw: number;
    crystals: number;
  };
}

interface MarkdownFile {
  kind: SearchKind;
  relPath: string;
  fullPath: string;
}

interface ParsedMarkdown {
  frontmatter: Partial<Frontmatter>;
  body: string;
}

const TOP_LEVEL: Record<"wiki" | "raw" | "crystals", SearchKind> = {
  wiki: "wiki",
  raw: "raw",
  crystals: "crystal",
};

export async function loadSearchCorpus(
  opts: LoadCorpusOptions,
): Promise<LoadCorpusResult> {
  const vaultRoot = resolve(opts.vaultRoot);
  const scope = opts.scope ?? "all";
  const allFiles = {
    wiki: await collectMarkdownFiles(vaultRoot, "wiki"),
    raw: await collectMarkdownFiles(vaultRoot, "raw"),
    crystals: await collectMarkdownFiles(vaultRoot, "crystals"),
  };
  const selected = selectedFilesForScope(allFiles, scope);
  const documents: SearchDocument[] = [];
  const errors: LoadCorpusResult["errors"] = [];

  for (const file of selected) {
    try {
      documents.push(await loadDocument(file));
    } catch (error) {
      errors.push({
        path: file.relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  documents.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    documents,
    errors,
    scannedCounts: {
      wiki: allFiles.wiki.length,
      raw: allFiles.raw.length,
      crystals: allFiles.crystals.length,
    },
  };
}

async function collectMarkdownFiles(
  vaultRoot: string,
  topLevel: keyof typeof TOP_LEVEL,
): Promise<MarkdownFile[]> {
  const root = join(vaultRoot, topLevel);
  const files: MarkdownFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({
          kind: TOP_LEVEL[topLevel],
          relPath: toVaultRelPath(vaultRoot, fullPath),
          fullPath: resolve(fullPath),
        });
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function selectedFilesForScope(
  files: Record<"wiki" | "raw" | "crystals", MarkdownFile[]>,
  scope: SearchScope,
): MarkdownFile[] {
  if (scope === "wiki") return files.wiki;
  if (scope === "raw") return files.raw;
  if (scope === "crystals") return files.crystals;
  return [...files.wiki, ...files.raw, ...files.crystals];
}

async function loadDocument(file: MarkdownFile): Promise<SearchDocument> {
  const [content, info] = await Promise.all([
    readFile(file.fullPath, "utf-8"),
    stat(file.fullPath),
  ]);
  const parsed = parseMarkdown(content);
  const filename = basename(file.relPath, ".md");
  const rawIdentity = parseRawIdentity(filename);
  const frontmatter = parsed.frontmatter;

  return {
    kind: file.kind,
    relPath: file.relPath,
    fullPath: file.fullPath,
    title: readString(frontmatter.title) ?? filename,
    type: readString(frontmatter.type) ?? defaultType(file),
    status: readString(frontmatter.status) ?? "active",
    confidence: readNumber(frontmatter.confidence),
    tags: readStringArray(frontmatter.tags),
    relations: readRelations(frontmatter.relations),
    source:
      file.kind === "raw"
        ? rawIdentity.source
        : readSearchSource(frontmatter.source),
    session: readString(frontmatter.session) ?? rawIdentity.session,
    body: parsed.body,
    snippetSource: firstNonEmptyLine(parsed.body),
    mtime: info.mtime.toISOString(),
    sizeBytes: info.size,
  };
}

function parseMarkdown(content: string): ParsedMarkdown {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) {
    return { frontmatter: {}, body: content };
  }

  const rest = content.slice(opening[0].length);
  const closing = /\r?\n---\r?\n/.exec(rest);
  if (!closing) {
    throw new Error("malformed frontmatter: missing closing --- marker");
  }

  const frontmatterText = rest.slice(0, closing.index);
  const body = rest.slice(closing.index + closing[0].length);
  return { frontmatter: parseMinimalYaml(frontmatterText), body };
}

function parseMinimalYaml(text: string): Partial<Frontmatter> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentNestedKey: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }

    const nestedArrayItem = /^ {4}- (.*)$/.exec(line);
    if (nestedArrayItem && currentKey && currentNestedKey) {
      const parent = ensureObject(result, currentKey);
      const values = ensureArray(parent, currentNestedKey);
      values.push(parseScalar(nestedArrayItem[1]!));
      continue;
    }

    const nestedKey = /^ {2}([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (nestedKey && currentKey) {
      const parent = ensureObject(result, currentKey);
      currentNestedKey = nestedKey[1]!;
      const value = nestedKey[2]?.trim() ?? "";
      parent[currentNestedKey] = value.length === 0 ? [] : parseScalar(value);
      continue;
    }

    const arrayItem = /^ {2}- (.*)$/.exec(line);
    if (arrayItem && currentKey) {
      const values = ensureArray(result, currentKey);
      values.push(parseScalar(arrayItem[1]!));
      continue;
    }

    const topLevel = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!topLevel) {
      throw new Error(`malformed frontmatter: unsupported line "${line}"`);
    }
    currentKey = topLevel[1]!;
    currentNestedKey = null;
    const value = topLevel[2]?.trim() ?? "";
    result[currentKey] = value.length === 0 ? [] : parseScalar(value);
  }

  return result as Partial<Frontmatter>;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map(parseScalar);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseInlineObject(trimmed.slice(1, -1));
  }
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (/^-?\d+(\.\d+)?$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseInlineObject(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const part of text.split(",")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    result[key] = parseScalar(value);
  }
  return result;
}

function ensureArray(
  target: Record<string, unknown>,
  key: string,
): unknown[] {
  const current = target[key];
  if (Array.isArray(current)) return current;
  const values: unknown[] = [];
  target[key] = values;
  return values;
}

function ensureObject(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const current = target[key];
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readRelations(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const relations: Record<string, string[]> = {};
  for (const [key, targets] of Object.entries(value)) {
    relations[key] = readStringArray(targets);
  }
  return relations;
}

function readSearchSource(value: unknown): SearchSource {
  if (
    value === "claude-code" ||
    value === "codex" ||
    value === "antigravity" ||
    value === "manual" ||
    value === "crystal"
  ) {
    return value;
  }
  return "unknown";
}

function defaultType(file: MarkdownFile): string {
  if (file.kind === "raw") return "raw-session";
  if (file.kind === "crystal") return "crystal";
  return file.relPath.split("/")[1] ?? "wiki";
}

function parseRawIdentity(filename: string): {
  source: SearchSource;
  session: string | null;
} {
  if (filename.startsWith("claude-code-")) {
    return { source: "claude-code", session: filename.slice("claude-code-".length) };
  }
  if (filename.startsWith("codex-")) {
    return { source: "codex", session: filename.slice("codex-".length) };
  }
  if (filename.startsWith("antigravity-")) {
    return { source: "antigravity", session: filename.slice("antigravity-".length) };
  }
  if (filename.startsWith("manual-")) {
    return { source: "manual", session: filename.slice("manual-".length) };
  }
  return {
    source: "unknown",
    session: filename.includes("-") ? filename.slice(filename.indexOf("-") + 1) : filename,
  };
}

function firstNonEmptyLine(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function toVaultRelPath(vaultRoot: string, fullPath: string): string {
  return relative(vaultRoot, fullPath).replace(/\\/g, "/");
}
