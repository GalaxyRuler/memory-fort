import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { canonicalizeRawObservation } from "../compile/canonicalize.js";
import { getConfidenceScore } from "../storage/confidence.js";
import {
  KNOWN_LIFECYCLE_STAGES,
  parseFrontmatter,
  type Frontmatter,
  type LifecycleStage,
} from "../storage/frontmatter.js";
import { buildGraph } from "./graph.js";
import { readRelations, type RelationMap } from "./relations.js";
import { isWikiDotDirectoryPath } from "./wiki-paths.js";

export type SearchScope = "wiki" | "raw" | "crystals" | "all";
// Source identifier for a memory document. Originally a strict union of agent
// identifiers; widened to plain string in Phase 3.1 so process names like
// import-agentmemory, backfill, consolidate, crystal-extraction, and
// codex-fork-smoke are first-class values alongside the original agent ids.
// "unknown" is reserved for the legacy sentinel "no source set" case.
export type SearchSource = string;
export type SearchKind = "wiki" | "raw" | "crystal";
export type CognitiveType = "core" | "semantic" | "episodic" | "procedural" | "prospective";

export interface SearchDocument {
  kind: SearchKind;
  relPath: string;
  fullPath: string;
  title: string;
  type: string;
  status: string;
  cognitiveType: CognitiveType;
  confidence: number | null;
  confidenceFull?: Frontmatter["confidence"];
  importance?: number | null;
  lifecycle?: LifecycleStage | null;
  due?: string | null;
  triggers?: string[];
  expires?: string | null;
  tags: string[];
  relations: RelationMap;
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
  /**
   * Cap on how many raw/ files are read into memory, keeping the most recent
   * (raw relPaths embed the date — `raw/<date>/...` — so lexical-descending
   * order is newest-first). Dashboard callers set this so a large raw pool
   * can't exhaust the heap (the graph holds every selected document at once);
   * compile/search omit it and load every raw file. Wiki/crystals are never
   * capped. `scannedCounts.raw` still reports the true on-disk total.
   */
  maxRawFiles?: number;
}

export interface LoadCorpusResult {
  documents: SearchDocument[];
  errors: Array<{ path: string; reason: string }>;
  /** True when `maxRawFiles` dropped some raw files from this load. */
  rawTruncated: boolean;
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
  const rawTotal = allFiles.raw.length;
  let rawTruncated = false;
  if (opts.maxRawFiles !== undefined && allFiles.raw.length > opts.maxRawFiles) {
    // raw relPaths embed the date (raw/<date>/...); newest-first, keep the cap.
    allFiles.raw = [...allFiles.raw]
      .sort((a, b) => b.relPath.localeCompare(a.relPath))
      .slice(0, opts.maxRawFiles);
    rawTruncated = true;
  }
  const selected = selectedFilesForScope(allFiles, scope);
  const documents: SearchDocument[] = [];
  const errors: LoadCorpusResult["errors"] = [];

  // Read + parse every file concurrently. The previous serial `await` loop made
  // a full-corpus load (~1900 files) take ~20s because each file's I/O latency
  // was paid one after another; fanning them out lets libuv's threadpool
  // overlap the reads.
  const loaded = await Promise.all(
    selected.map(async (file) => {
      try {
        return { document: await loadDocument(file) };
      } catch (error) {
        return {
          error: {
            path: file.relPath,
            reason: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }),
  );
  for (const result of loaded) {
    if (result.document) documents.push(result.document);
    else errors.push(result.error);
  }

  // The crystals scope over-collects (the wiki pool) so wiki/crystals/ pages are
  // reachable; narrow to the actual crystal documents here.
  const scopedDocuments = scope === "crystals" ? documents.filter(isCrystalDocument) : documents;

  scopedDocuments.sort((a, b) => a.relPath.localeCompare(b.relPath));
  applyCognitiveTypeInference(scopedDocuments);
  return {
    documents: scopedDocuments,
    errors,
    rawTruncated,
    scannedCounts: {
      wiki: allFiles.wiki.length,
      raw: rawTotal,
      crystals: scope === "crystals" ? scopedDocuments.length : allFiles.crystals.length,
    },
  };
}

export async function loadSearchCorpusFileSignature(
  opts: LoadCorpusOptions,
): Promise<string> {
  const vaultRoot = resolve(opts.vaultRoot);
  const scope = opts.scope ?? "all";
  const allFiles = {
    wiki: await collectMarkdownFiles(vaultRoot, "wiki"),
    raw: await collectMarkdownFiles(vaultRoot, "raw"),
    crystals: await collectMarkdownFiles(vaultRoot, "crystals"),
  };
  const selected = selectedFilesForScope(allFiles, scope);
  const entries = await Promise.all(
    selected.map(async (file) => {
      const info = await stat(file.fullPath);
      return [file.relPath, info.mtime.toISOString(), info.size].join("\u0000");
    }),
  );
  return [vaultRoot, scope, ...entries.sort()].join("\u0001");
}

export function searchCorpusSignatureFromDocuments(
  vaultRoot: string,
  scope: SearchScope,
  documents: SearchDocument[],
): string {
  return [
    resolve(vaultRoot),
    scope,
    ...documents.map((document) =>
      [
        document.relPath,
        document.mtime,
        document.sizeBytes,
      ].join("\u0000"),
    ).sort(),
  ].join("\u0001");
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
      const relPath = toVaultRelPath(vaultRoot, fullPath);
      if (entry.isDirectory()) {
        if (
          topLevel === "wiki" &&
          (relPath.startsWith("wiki/archive/") || isWikiDotDirectoryPath(relPath))
        ) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (topLevel === "wiki" && isWikiDotDirectoryPath(relPath)) continue;
        files.push({
          kind: TOP_LEVEL[topLevel],
          relPath,
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
  // Crystals are curated pages, usually authored under `wiki/crystals/` rather
  // than a top-level `crystals/` dir, so they are collected as wiki files. Load
  // the wiki pool (plus any top-level crystals dir) and let the caller filter
  // down to the crystal documents by kind/type after parsing.
  if (scope === "crystals") return [...files.wiki, ...files.crystals];
  return [...files.wiki, ...files.raw, ...files.crystals];
}

function isCrystalDocument(document: SearchDocument): boolean {
  return document.kind === "crystal" || document.type === "crystal" || document.type === "crystals";
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
    confidence: canonical?.confidence ?? readConfidenceScore(frontmatter.confidence),
    confidenceFull: frontmatter.confidence,
    importance: readImportance(frontmatter.importance),
    lifecycle: readLifecycle(frontmatter.lifecycle),
    due: readOptionalDateString(frontmatter.due),
    triggers: readStringArray(frontmatter.triggers),
    expires: readOptionalDateString(frontmatter.expires),
    tags: canonical?.tags ?? readStringArray(frontmatter.tags),
    relations: readRelations(frontmatter.relations, file.relPath),
    source:
      canonical?.source ??
      (file.kind === "raw"
        ? rawIdentity.source
        : readSearchSource(frontmatter.source)),
    session: canonical?.session ?? readString(frontmatter.session) ?? rawIdentity.session,
    agentSessionId: canonical?.session ?? null,
    toolCallsSummary: canonical?.toolCallsSummary ?? [],
    topicTags: canonical?.topicTags ?? [],
    // Always carry the parsed frontmatter — temporal (valid_from/valid_until)
    // and identity (agent_id/user_id) filters read it for every doc kind.
    rawFrontmatter: canonical?.rawFrontmatter ?? (frontmatter as Record<string, unknown>),
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
  if (category === "prospective") return "prospective";
  if (category === "threads") return "episodic";
  if (category === "procedures") return "procedural";

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

  return parseFrontmatter(content);
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

function readOptionalDateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function readConfidenceScore(value: Partial<Frontmatter>["confidence"]): number | null {
  return value === undefined ? null : getConfidenceScore(value);
}

function readImportance(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readLifecycle(value: unknown): LifecycleStage | null {
  return KNOWN_LIFECYCLE_STAGES.includes(value as never)
    ? value as LifecycleStage
    : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return "unknown";
}

function readCognitiveType(value: unknown): CognitiveType | null {
  if (
    value === "core" ||
    value === "semantic" ||
    value === "episodic" ||
    value === "procedural" ||
    value === "prospective"
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
  if (document.relPath.startsWith("wiki/threads-proposed/")) return "threads";
  if (document.relPath.startsWith("wiki/procedures/")) return "procedures";
  if (document.relPath.startsWith("wiki/procedures-proposed/")) return "procedures";
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
