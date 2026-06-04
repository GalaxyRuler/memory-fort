import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadEmbeddings, type EmbeddingRecord } from "../retrieval/embeddings-store.js";
import {
  hasUsableEmbeddingDimensions,
  isUnitStubVector,
  isZeroVector,
  vectorsEqual,
} from "../retrieval/embedding-health.js";
import { readRelations, writeRelations, type RelationEdge, type RelationMap } from "../retrieval/relations.js";
import { isEntityWikiPath } from "../retrieval/wiki-paths.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../storage/frontmatter.js";
import { memoryRoot as defaultMemoryRoot } from "../storage/paths.js";

export type AutoLinkStrategy = "embedding" | "title";

export interface AutoLinkMatch {
  target: string;
  score: number;
  strategy: AutoLinkStrategy;
}

export interface AutoLinkRawOptions {
  vaultRoot?: string;
  threshold?: number;
  titleThreshold?: number;
  expectedEmbeddingDim?: number;
  minEmbeddingDim?: number;
  apply?: boolean;
  maxLinks?: number;
  now?: Date;
}

export interface AutoLinkRawResult {
  path: string;
  linked: AutoLinkMatch[];
  skipped: boolean;
  reason?: string;
}

interface WikiCandidate {
  relPath: string;
  title: string;
  aliases: string[];
  summary: string;
  body: string;
}

interface FindMatchesResult {
  matches: AutoLinkMatch[];
  reason?: string;
}

const DEFAULT_THRESHOLD = 0.65;
const DEFAULT_TITLE_THRESHOLD = 0.55;
const DEFAULT_MIN_EMBEDDING_DIM = 16;
const DEFAULT_MAX_LINKS = 3;
const RAW_MATCH_SNIPPET_CHARS = 4096;
const CANDIDATE_SUMMARY_CHARS = 800;
const TOP_K_COLLISION_CANDIDATES = 3;
const AUTO_LINK_WIKI_PREFIXES = [
  "wiki/projects/",
  "wiki/issues/",
  "wiki/people/",
  "wiki/decisions/",
  "wiki/lessons/",
  "wiki/prospective/",
  "wiki/procedures/",
  "wiki/threads/",
  "wiki/references/",
  "wiki/tools/",
] as const;

export async function autoLinkRawToWiki(
  rawPath: string,
  opts: AutoLinkRawOptions = {},
): Promise<AutoLinkRawResult> {
  const vaultRoot = resolve(opts.vaultRoot ?? defaultMemoryRoot());
  const relPath = normalizeRawRelPath(vaultRoot, rawPath);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  if (!relPath.startsWith("raw/") || !relPath.endsWith(".md")) {
    return { path: relPath, linked: [], skipped: true, reason: "not a raw markdown path" };
  }
  if (!existsSync(fullPath)) {
    return { path: relPath, linked: [], skipped: true, reason: "raw file not found" };
  }

  const content = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(content);
  const relations = readRelations(parsed.frontmatter.relations, relPath);
  if (hasAnyRelation(relations)) {
    return { path: relPath, linked: [], skipped: true, reason: "raw already has relations" };
  }

  const threshold = clampThreshold(opts.threshold ?? DEFAULT_THRESHOLD);
  const maxLinks = Math.max(1, Math.floor(opts.maxLinks ?? DEFAULT_MAX_LINKS));
  const matchResult = await findMatches({
    vaultRoot,
    rawRelPath: relPath,
    title: typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : "",
    body: parsed.body,
    threshold,
    titleThreshold: clampThreshold(opts.titleThreshold ?? DEFAULT_TITLE_THRESHOLD),
    expectedEmbeddingDim: opts.expectedEmbeddingDim,
    minEmbeddingDim: Math.max(1, Math.floor(opts.minEmbeddingDim ?? DEFAULT_MIN_EMBEDDING_DIM)),
    maxLinks,
  });
  const matches = matchResult.matches;

  if (opts.apply && matches.length > 0) {
    const nextRelations = addMentionEdges(relations, matches, {
      sessionId: typeof parsed.frontmatter.session === "string" ? parsed.frontmatter.session : sessionFromRawPath(relPath),
      capturedAt: (opts.now ?? new Date()).toISOString(),
    });
    await atomicWrite(
      fullPath,
      serializeFrontmatter({
        ...parsed.frontmatter,
        relations: writeRelations(nextRelations),
      }, parsed.body),
    );
  }

  return {
    path: relPath,
    linked: matches,
    skipped: matches.length === 0,
    reason: matches.length === 0 ? matchResult.reason : undefined,
  };
}

async function findMatches(input: {
  vaultRoot: string;
  rawRelPath: string;
  title: string;
  body: string;
  threshold: number;
  titleThreshold: number;
  expectedEmbeddingDim?: number;
  minEmbeddingDim: number;
  maxLinks: number;
}): Promise<FindMatchesResult> {
  const [wikiEmbeddings, rawEmbeddings] = await Promise.all([
    loadEmbeddings(input.vaultRoot, "wiki"),
    loadEmbeddings(input.vaultRoot, "raw"),
  ]);
  const rawRecord = rawEmbeddings.records.find((record) => record.path === input.rawRelPath);
  const wikiRecords = wikiEmbeddings.records.filter((record) =>
    !record.archived && isAutoLinkWikiTarget(record.path)
  );
  const embeddingDegenerate = rawRecord && wikiRecords.length > 0
    ? embeddingSignalDegenerate({
      rawRecord,
      wikiRecords,
      expectedDim: input.expectedEmbeddingDim,
      minDim: input.minEmbeddingDim,
    })
    : null;

  if (rawRecord && wikiRecords.length > 0 && !embeddingDegenerate) {
    const matches = wikiRecords
      .map((record) => ({
        target: record.path,
        score: cosineSimilarity(rawRecord.vector, record.vector),
        strategy: "embedding" as const,
      }))
      .filter((match) => match.score >= input.threshold)
      .sort(compareMatches)
      .slice(0, input.maxLinks);
    return { matches };
  }

  const candidates = await listWikiCandidates(input.vaultRoot);
  const rawText = `${input.title}\n${input.body.slice(0, RAW_MATCH_SNIPPET_CHARS)}`;
  const matches = candidates
    .map((candidate) => ({
      target: candidate.relPath,
      score: titleMatchScore(rawText, candidate),
      strategy: "title" as const,
    }))
    .filter((match) => match.score >= input.titleThreshold)
    .sort(compareMatches)
    .slice(0, input.maxLinks);
  return {
    matches,
    reason: matches.length === 0 && embeddingDegenerate ? "degenerate embeddings" : undefined,
  };
}

function addMentionEdges(
  relations: RelationMap,
  matches: AutoLinkMatch[],
  source: { sessionId: string; capturedAt: string },
): RelationMap {
  const mentions = relations.mentions ?? [];
  const existingTargets = new Set(mentions.map((edge) => edge.target));
  const next: RelationEdge[] = [...mentions];
  for (const match of matches) {
    if (existingTargets.has(match.target)) continue;
    existingTargets.add(match.target);
    next.push({
      target: match.target,
      confidence: round(match.score, 3),
      source: {
        agent: "auto-link",
        session_id: source.sessionId,
        captured_at: source.capturedAt,
      },
    });
  }
  return { ...relations, mentions: next };
}

async function listWikiCandidates(vaultRoot: string): Promise<WikiCandidate[]> {
  const wikiRoot = join(vaultRoot, "wiki");
  if (!existsSync(wikiRoot)) return [];
  const candidates: WikiCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(vaultRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (relPath.split("/").some((part) => part.startsWith(".") || part.endsWith("-proposed") || part === "archive")) {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md") || !isAutoLinkWikiTarget(relPath)) continue;
      const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
      candidates.push({
        relPath,
        title: typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : relPath.split("/").at(-1)!.replace(/\.md$/, ""),
        aliases: readAliases(parsed.frontmatter.aliases),
        summary: typeof parsed.frontmatter.summary === "string" ? parsed.frontmatter.summary : "",
        body: parsed.body,
      });
    }
  }

  await walk(wikiRoot);
  return candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function isAutoLinkWikiTarget(relPath: string): boolean {
  return isEntityWikiPath(relPath) &&
    AUTO_LINK_WIKI_PREFIXES.some((prefix) => relPath.startsWith(prefix)) &&
    !relPath.includes("-proposed/");
}

function titleMatchScore(rawText: string, candidate: WikiCandidate): number {
  const titleTokens = tokenSet([candidate.title, ...candidate.aliases].join(" "));
  const candidateTokens = tokenSet([
    candidate.title,
    ...candidate.aliases,
    candidate.summary,
    candidate.body.slice(0, CANDIDATE_SUMMARY_CHARS),
  ].join("\n"));
  if (titleTokens.size === 0 || candidateTokens.size === 0) return 0;
  const rawTokens = tokenSet(rawText);
  const normalizedRaw = normalizePhrase(rawText);
  const titlePhrase = normalizePhrase(candidate.title);
  const phraseBonus = titlePhrase.length > 0 && normalizedRaw.includes(titlePhrase) ? 0.1 : 0;
  let titleOverlap = 0;
  for (const token of titleTokens) {
    if (rawTokens.has(token)) titleOverlap += 1;
  }
  if (titleOverlap === 0) return 0;
  const supportTokens = new Set([...candidateTokens].filter((token) => !titleTokens.has(token)));
  let supportOverlap = 0;
  for (const token of supportTokens) {
    if (rawTokens.has(token)) supportOverlap += 1;
  }
  let candidateOverlap = 0;
  for (const token of candidateTokens) {
    if (rawTokens.has(token)) candidateOverlap += 1;
  }
  const titleCoverage = titleOverlap / titleTokens.size;
  const supportCoverage = supportTokens.size === 0 ? 0 : supportOverlap / supportTokens.size;
  const jaccard = candidateOverlap / new Set([...candidateTokens, ...rawTokens]).size;
  return round(Math.min(1, (titleCoverage * 0.42) + (supportCoverage * 0.43) + (jaccard * 0.15) + phraseBonus), 3);
}

function tokenSet(value: string): Set<string> {
  return new Set(scoringTokens(value));
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "have",
  "has",
  "are",
  "was",
  "were",
  "not",
  "no",
]);

const PURE_NUMERIC_TOKEN = /^\d+$/;

function scoringTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token) && !PURE_NUMERIC_TOKEN.test(token));
}

function normalizePhrase(value: string): string {
  return scoringTokens(value).join(" ");
}

function readAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
}

function embeddingSignalDegenerate(input: {
  rawRecord: EmbeddingRecord;
  wikiRecords: EmbeddingRecord[];
  expectedDim?: number;
  minDim: number;
}): string | null {
  const sampledRecords = [input.rawRecord, ...input.wikiRecords.slice(0, TOP_K_COLLISION_CANDIDATES)];
  if (!hasUsableEmbeddingDimensions(sampledRecords, {
    expectedDim: input.expectedDim,
    minDim: input.minDim,
  })) {
    return "dimension";
  }

  if (
    isUnitStubVector(input.rawRecord.vector) ||
    isZeroVector(input.rawRecord.vector) ||
    input.wikiRecords.some((record) => vectorsEqual(input.rawRecord.vector, record.vector))
  ) {
    return "collision";
  }

  const scores = input.wikiRecords
    .map((record) => cosineSimilarity(input.rawRecord.vector, record.vector))
    .sort((a, b) => b - a)
    .slice(0, TOP_K_COLLISION_CANDIDATES);
  if (scores.length >= 2 && scores.every((score) => score >= 0.999)) {
    return "top-k-collision";
  }

  return null;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function compareMatches(a: AutoLinkMatch, b: AutoLinkMatch): number {
  return b.score - a.score || a.target.localeCompare(b.target);
}

function hasAnyRelation(relations: RelationMap): boolean {
  return Object.values(relations).some((edges) => edges.length > 0);
}

function normalizeRawRelPath(vaultRoot: string, rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, "/");
  if (!isAbsolute(rawPath)) return normalized.replace(/^\/+/, "");
  return relative(vaultRoot, resolve(rawPath)).replace(/\\/g, "/");
}

function sessionFromRawPath(relPath: string): string {
  return relPath.split("/").at(-1)?.replace(/\.md$/, "").replace(/^(codex|claude-code|antigravity|manual)-/, "") ?? "unknown";
}

function clampThreshold(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_THRESHOLD;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
