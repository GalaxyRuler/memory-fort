import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { canonicalizeRawObservation } from "../compile/canonicalize.js";
import type { Frontmatter } from "../storage/frontmatter.js";
import { buildGraph } from "./graph.js";

export type SearchScope = "wiki" | "raw" | "crystals" | "all";
export type SearchSource =
  | "claude-code"
  | "codex"
  | "antigravity"
  | "manual"
  | "crystal"
  | "unknown";
export type SearchKind = "wiki" | "raw" | "crystal";
export type CognitiveType = "core" | "semantic" | "episodic" | "procedural";

export interface SearchDocument {
  kind: SearchKind;
  relPath: string;
  fullPath: string;
  title: string;
  type: string;
  status: string;
  cognitiveType: CognitiveType;
  confidence: number | null;
  tags: string[];
  relations: Record<string, string[]>;
  source: SearchSource;
  session: string | null;
  agentSessionId?: string | null;
  toolCallsSummary?: string[];
  topicTags?: string[];
  rawFrontmatter?: Record<string, unknown> | null;
  importedFrom: {
    system: string | null;
    originalKey: string | null;
  } | null;
  body: string;
  snippetSource: string;
  created: string | null;
  observedAt: string | null;
  updated: string | null;
  mtime: string;
  sizeBytes: number;
  explicitCognitiveType?: CognitiveType | null;
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
  applyCognitiveTypeInference(documents);
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
        if (
          topLevel === "wiki" &&
          toVaultRelPath(vaultRoot, fullPath).startsWith("wiki/archive/")
        ) {
          continue;
        }
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
  const explicitCognitiveType = readCognitiveType(frontmatter.cognitive_type);
  const canonical =
    file.kind === "raw"
      ? canonicalizeRawObservation({
          filename,
          identity: rawIdentity,
          frontmatter: frontmatter as Record<string, unknown>,
          body: parsed.body,
        })
      : null;

  return {
    kind: file.kind,
    relPath: file.relPath,
    fullPath: file.fullPath,
    title: canonical?.title ?? readString(frontmatter.title) ?? filename,
    type: readString(frontmatter.type) ?? defaultType(file),
    status: readString(frontmatter.status) ?? "active",
    cognitiveType: explicitCognitiveType ?? "semantic",
    confidence: canonical?.confidence ?? readNumber(frontmatter.confidence),
    tags: canonical?.tags ?? readStringArray(frontmatter.tags),
    relations: readRelations(frontmatter.relations),
    source:
      canonical?.source ??
      (file.kind === "raw"
        ? rawIdentity.source
        : readSearchSource(frontmatter.source)),
    session: canonical?.session ?? readString(frontmatter.session) ?? rawIdentity.session,
    agentSessionId: canonical?.session ?? null,
    toolCallsSummary: canonical?.toolCallsSummary ?? [],
    topicTags: canonical?.topicTags ?? [],
    rawFrontmatter: canonical?.rawFrontmatter ?? null,
    importedFrom: readImportedFrom(frontmatter.imported_from),
    body: canonical?.body ?? parsed.body,
    snippetSource: firstNonEmptyLine(parsed.body),
    created: readDate(frontmatter.created),
    observedAt: readDate(frontmatter.observed_at),
    updated: readUpdated(frontmatter.updated),
    mtime: info.mtime.toISOString(),
    sizeBytes: info.size,
    explicitCognitiveType,
  };
}

function applyCognitiveTypeInference(documents: SearchDocument[]): void {
  if (documents.length === 0) return;

  const graph = buildGraph(documents);
  for (const document of documents) {
    const inferred = inferCognitiveType(
      document,
      graph.nodes.get(document.relPath)?.inbound.length ?? 0,
    );
    document.cognitiveType = shouldHonorExplicitCognitiveType(document)
      ? document.explicitCognitiveType!
      : inferred;
  }
}

function shouldHonorExplicitCognitiveType(document: SearchDocument): boolean {
  if (!document.explicitCognitiveType) return false;
  if (document.kind === "raw") return false;
  const key = document.importedFrom?.originalKey ?? "";
  if (
    document.importedFrom?.system === "agentmemory" &&
    (key.startsWith("mem:slots:") ||
      key.startsWith("mem:semantic:") ||
      key.startsWith("mem:summaries:"))
  ) {
    return false;
  }
  return true;
}

export function inferCognitiveType(
  document: Pick<SearchDocument, "relPath" | "kind" | "type" | "status" | "source" | "created" | "observedAt" | "importedFrom">,
  inboundCount = 0,
  now = new Date(),
): CognitiveType {
  const category = categoryForDocument(document);
  const imported = document.importedFrom;
  const originalKey = imported?.originalKey ?? "";
  if (
    imported?.system === "agentmemory" &&
    originalKey.startsWith("mem:slots:")
  ) {
    return "core";
  }
  if (document.source === "crystal" || category === "crystals") return "semantic";

  if (
    imported?.system === "agentmemory" &&
    (originalKey.startsWith("mem:semantic:") ||
      originalKey.startsWith("mem:summaries:"))
  ) {
    return "semantic";
  }

  if (category === "projects" && document.status === "active" && inboundCount >= 5) return "core";
  if (category === "tools" || category === "lessons") return "procedural";
  if (category === "references" || category === "decisions" || category === "crystals") {
    return "semantic";
  }

  // Agentmemory is being retired — every imported observation from it is
  // archival by definition and should settle into semantic, regardless of age.
  if (imported?.system === "agentmemory") {
    return "semantic";
  }

  if (document.relPath.startsWith("raw/")) {
    return isWithinLastDays(document.observedAt ?? document.created, 30, now) ? "episodic" : "semantic";
  }

  return "semantic";
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

function readDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

function readUpdated(value: unknown): string | null {
  return readDate(value);
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

function readImportedFrom(value: unknown): SearchDocument["importedFrom"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    system: readStringOrFirst(record["system"]),
    originalKey: readStringOrFirst(record["original_key"]),
  };
}

function readStringOrFirst(value: unknown): string | null {
  return readString(value) ?? (Array.isArray(value) ? readString(value[0]) : null);
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

function readCognitiveType(value: unknown): CognitiveType | null {
  if (
    value === "core" ||
    value === "semantic" ||
    value === "episodic" ||
    value === "procedural"
  ) {
    return value;
  }
  return null;
}

function categoryForDocument(
  document: Pick<SearchDocument, "relPath" | "kind" | "type">,
): string {
  if (document.kind === "crystal") return "crystals";
  if (document.type === "crystal") return "crystals";
  return document.type || document.relPath.split("/")[1] || document.kind;
}

function isWithinLastDays(value: string | null, days: number, now: Date): boolean {
  if (!value) return false;
  const created = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(created)) return false;
  const ageMs = now.getTime() - created;
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
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
