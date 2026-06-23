import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import { parseFrontmatter } from "../storage/frontmatter.js";
import type { PageType } from "../storage/paths.js";
import { kebabCase } from "../storage/slug.js";
import { loadCompressedFacts, type CompressedFact, type CompressedFactType } from "../facts/store.js";
import { addTokenUsage } from "../facts/compress.js";
import type { CompileOperationOutcome } from "./execute.js";
import { filterNoiseForPage } from "./filter-noise.js";
import { synthesizeNarrative } from "./synthesize-narrative.js";

export interface FactConsolidationOptions {
  vaultRoot: string;
  llm: LLMProvider;
  maxCalls?: number;
  topK?: number;
  minFacts?: number;
  minImportance?: number;
  timeoutMs?: number;
  now?: Date;
  faithfulnessCheck?: boolean;
}

export interface FactConsolidationResult {
  mode: "execute";
  applied: string[];
  proposed: string[];
  planned: string[];
  rejected: Array<{ path: string; reason: string }>;
  outcomes: CompileOperationOutcome[];
  referencesStripped: number;
  prosePathLeaks: number;
  pagesRewritten: number;
  pagesUpdated: number;
  pagesUnchanged: number;
  factsExtracted: number;
  sessionsScanned: number;
  rewriteTokensUsed?: LLMTokenUsage;
  summary: {
    factsLoaded: number;
    factsConsidered: number;
    conceptsEligible: number;
    llmCalls: number;
    pagesUpdated: number;
    pagesUnchanged: number;
  };
}

const DEFAULT_MAX_CALLS = 10;
const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_FACTS = 3;
const DEFAULT_MIN_IMPORTANCE = 4;
const DEFAULT_TIMEOUT_MS = 30_000;

export async function runFactConsolidation(opts: FactConsolidationOptions): Promise<FactConsolidationResult> {
  const facts = await loadCompressedFacts(opts.vaultRoot);
  const pageIndex = await buildKnowledgePageIndex(opts.vaultRoot);
  const minImportance = opts.minImportance ?? DEFAULT_MIN_IMPORTANCE;
  const grouped = groupFactsByConcept(facts.filter((fact) => fact.importance >= minImportance));
  const candidates = [...grouped.entries()]
    .map(([concept, conceptFacts]) => ({ concept, facts: conceptFacts, page: selectPageForFacts(pageIndex, concept, conceptFacts) }))
    .filter((candidate): candidate is { concept: string; facts: CompressedFact[]; page: KnowledgePage } =>
      candidate.page !== undefined && candidate.facts.length >= (opts.minFacts ?? DEFAULT_MIN_FACTS)
    )
    .sort((a, b) => bestImportance(b.facts) - bestImportance(a.facts) || a.concept.localeCompare(b.concept));

  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  void (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const applied: FactConsolidationResult["applied"] = [];
  const proposed: FactConsolidationResult["proposed"] = [];
  const planned: FactConsolidationResult["planned"] = [];
  const rejected: FactConsolidationResult["rejected"] = [];
  const outcomes: CompileOperationOutcome[] = [];
  let referencesStripped = 0;
  let prosePathLeaks = 0;
  let pagesRewritten = 0;
  let pagesUpdated = 0;
  let pagesUnchanged = 0;
  let rewriteTokensUsed: LLMTokenUsage | undefined;
  let llmCalls = 0;
  let factsConsidered = 0;

  for (const candidate of candidates.slice(0, maxCalls)) {
    const selectedFacts = candidate.facts
      .sort((a, b) => b.importance - a.importance || a.observedAt.localeCompare(b.observedAt))
      .slice(0, topK);
    factsConsidered += selectedFacts.length;
    const filtered = filterNoiseForPage(candidate.page.title, selectedFacts);
    if (filtered.accepted.length === 0) {
      pagesUnchanged += 1;
      continue;
    }
    let result;
    try {
      result = await synthesizeNarrative({
        vaultRoot: opts.vaultRoot,
        pageRelPath: candidate.page.relPath,
        facts: filtered.accepted,
        llm: opts.llm,
        now: opts.now ?? new Date(),
        faithfulnessCheck: opts.faithfulnessCheck,
      });
    } catch (error) {
      // One bad LLM response (e.g. invalid JSON from a weaker model) must not
      // abort the whole consolidation run — skip this candidate and continue.
      llmCalls += 1;
      rejected.push({
        path: candidate.page.relPath,
        reason: `narrative synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      outcomes.push({
        path: candidate.page.relPath,
        outcome: "rejected",
        reason: `narrative synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
        contentPreserved: true,
      });
      continue;
    }
    llmCalls += result.llmCalls;
    rewriteTokensUsed = addTokenUsage(rewriteTokensUsed, result.tokensUsed);

    if (result.outcome === "unchanged") {
      pagesUnchanged += 1;
      continue;
    }
    if (result.outcome === "rewritten") {
      applied.push(candidate.page.relPath);
      pagesRewritten += 1;
      pagesUpdated += 1;
      outcomes.push({
        path: candidate.page.relPath,
        outcome: "rewritten",
        contentPreserved: true,
      });
      continue;
    }
    if (result.proposedPath) proposed.push(result.proposedPath);
    outcomes.push({
      path: candidate.page.relPath,
      outcome: "staged-for-review",
      reason: result.reason ?? "narrative synthesis staged for review",
      contentPreserved: true,
    });
  }

  return {
    mode: "execute",
    applied,
    proposed,
    planned,
    rejected,
    outcomes,
    referencesStripped,
    prosePathLeaks,
    pagesRewritten,
    pagesUpdated,
    pagesUnchanged,
    factsExtracted: 0,
    sessionsScanned: new Set(facts.map((fact) => fact.sessionId)).size,
    ...(rewriteTokensUsed ? { rewriteTokensUsed } : {}),
    summary: {
      factsLoaded: facts.length,
      factsConsidered,
      conceptsEligible: candidates.length,
      llmCalls,
      pagesUpdated,
      pagesUnchanged,
    },
  };
}

interface KnowledgePage {
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
  type: PageType;
}

async function buildKnowledgePageIndex(vaultRoot: string): Promise<Map<string, KnowledgePage[]>> {
  const wikiRoot = join(vaultRoot, "wiki");
  const pages = new Map<string, KnowledgePage[]>();
  if (!existsSync(wikiRoot)) return pages;
  for (const fullPath of await listWikiPages(wikiRoot)) {
    const relPath = `wiki/${relative(wikiRoot, fullPath).replace(/\\/g, "/")}`;
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : basename(relPath, ".md");
    const type = readPageType(parsed.frontmatter.type, relPath);
    if (!type) continue;
    const page = { relPath, frontmatter: parsed.frontmatter, body: parsed.body, title, type };
    addIndexedPage(pages, normalizeConcept(title), page);
    addIndexedPage(pages, normalizeConcept(basename(relPath, ".md").replace(/-/g, " ")), page);
  }
  return pages;
}

function addIndexedPage(pages: Map<string, KnowledgePage[]>, key: string, page: KnowledgePage): void {
  if (!key) return;
  const bucket = pages.get(key) ?? [];
  if (!bucket.some((candidate) => candidate.relPath === page.relPath)) {
    bucket.push(page);
    bucket.sort((a, b) => a.relPath.localeCompare(b.relPath));
  }
  pages.set(key, bucket);
}

function selectPageForFacts(
  pageIndex: Map<string, KnowledgePage[]>,
  concept: string,
  facts: CompressedFact[],
): KnowledgePage | undefined {
  const pages = pageIndex.get(normalizeConcept(concept)) ?? [];
  if (pages.length <= 1) return pages[0];
  const preferredType = dominantPageType(facts);
  if (preferredType) {
    const typed = pages.find((page) => page.type === preferredType);
    if (typed) return typed;
  }
  return pages[0];
}

function dominantPageType(facts: CompressedFact[]): PageType | null {
  const counts = new Map<PageType, number>();
  for (const fact of facts) {
    const type = factTypeToPageType(fact.type);
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function factTypeToPageType(type: CompressedFactType | undefined): PageType | null {
  switch (type) {
    case "project":
      return "projects";
    case "decision":
      return "decisions";
    case "procedure":
      return "procedures";
    case "lesson":
      return "lessons";
    case "reference":
      return "references";
    case "tool":
      return "tools";
    case "people":
      return "people";
    case "fact":
    case undefined:
      return null;
  }
}

function readPageType(value: unknown, relPath: string): PageType | null {
  if (typeof value === "string" && isPageType(value)) return value;
  const match = /^wiki\/([^/]+)\//.exec(relPath);
  return match?.[1] && isPageType(match[1]) ? match[1] : null;
}

function isPageType(value: string): value is PageType {
  return [
    "projects",
    "people",
    "decisions",
    "lessons",
    "prospective",
    "procedures",
    "threads",
    "references",
    "tools",
  ].includes(value);
}

async function listWikiPages(wikiRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const rel = relative(wikiRoot, fullPath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.startsWith(".") || part.endsWith("-proposed") || part === "archive")) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  await walk(wikiRoot);
  return files.sort();
}

function groupFactsByConcept(facts: CompressedFact[]): Map<string, CompressedFact[]> {
  const grouped = new Map<string, CompressedFact[]>();
  for (const fact of facts) {
    for (const concept of fact.concepts) {
      const normalized = normalizeConcept(concept);
      if (!normalized) continue;
      const bucket = grouped.get(normalized) ?? [];
      bucket.push(fact);
      grouped.set(normalized, bucket);
    }
  }
  return grouped;
}

function normalizeConcept(value: string): string {
  return kebabCase(value).replace(/-/g, " ").trim().toLowerCase();
}

function bestImportance(facts: CompressedFact[]): number {
  return Math.max(...facts.map((fact) => fact.importance));
}
