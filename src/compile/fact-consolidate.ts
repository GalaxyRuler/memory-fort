import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import { parseFrontmatter } from "../storage/frontmatter.js";
import { kebabCase } from "../storage/slug.js";
import { loadCompressedFacts, type CompressedFact } from "../facts/store.js";
import { addTokenUsage } from "../facts/compress.js";
import { applyCompileOperations, type CompileOperationOutcome } from "./execute.js";

export interface FactConsolidationOptions {
  vaultRoot: string;
  llm: LLMProvider;
  maxCalls?: number;
  topK?: number;
  minFacts?: number;
  minImportance?: number;
  timeoutMs?: number;
  now?: Date;
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
    .map(([concept, conceptFacts]) => ({ concept, facts: conceptFacts, page: pageIndex.get(normalizeConcept(concept)) }))
    .filter((candidate): candidate is { concept: string; facts: CompressedFact[]; page: KnowledgePage } =>
      candidate.page !== undefined && candidate.facts.length >= (opts.minFacts ?? DEFAULT_MIN_FACTS)
    )
    .sort((a, b) => bestImportance(b.facts) - bestImportance(a.facts) || a.concept.localeCompare(b.concept));

  const maxCalls = opts.maxCalls ?? DEFAULT_MAX_CALLS;
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const prompt = buildSynthesisPrompt(candidate.page, selectedFacts);
    const response = await chatWithTimeout(opts.llm, prompt, timeoutMs);
    llmCalls += 1;
    rewriteTokensUsed = addTokenUsage(rewriteTokensUsed, response.tokensUsed);
    const body = parseSynthesisBody(response.content);
    if (!body) {
      rejected.push({ path: candidate.page.relPath, reason: "fact synthesis returned no JSON body" });
      outcomes.push({
        path: candidate.page.relPath,
        outcome: "rejected",
        reason: "fact synthesis returned no JSON body",
        contentPreserved: false,
      });
      continue;
    }
    const result = await applyCompileOperations({
      vaultRoot: opts.vaultRoot,
      now: opts.now,
      operations: [{
        kind: "rewrite_page",
        path: candidate.page.relPath,
        frontmatter: {
          ...candidate.page.frontmatter,
          confidence: 0.9,
          relations: {
            ...(typeof candidate.page.frontmatter.relations === "object" && candidate.page.frontmatter.relations !== null
              ? candidate.page.frontmatter.relations as Record<string, unknown>
              : {}),
            derived_from: Array.from(new Set(selectedFacts.map((fact) => fact.sourceRawPath))),
          },
        },
        body,
      }],
    });
    applied.push(...result.applied);
    proposed.push(...result.proposed);
    planned.push(...result.planned);
    rejected.push(...result.rejected);
    outcomes.push(...result.outcomes);
    referencesStripped += result.referencesStripped;
    prosePathLeaks += result.prosePathLeaks;
    pagesRewritten += result.pagesRewritten;
    pagesUpdated += result.pagesUpdated;
    pagesUnchanged += result.pagesUnchanged;
    rewriteTokensUsed = addTokenUsage(rewriteTokensUsed, result.rewriteTokensUsed);
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
}

async function buildKnowledgePageIndex(vaultRoot: string): Promise<Map<string, KnowledgePage>> {
  const wikiRoot = join(vaultRoot, "wiki");
  const pages = new Map<string, KnowledgePage>();
  if (!existsSync(wikiRoot)) return pages;
  for (const fullPath of await listWikiPages(wikiRoot)) {
    const relPath = `wiki/${relative(wikiRoot, fullPath).replace(/\\/g, "/")}`;
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : basename(relPath, ".md");
    const page = { relPath, frontmatter: parsed.frontmatter, body: parsed.body };
    pages.set(normalizeConcept(title), page);
    pages.set(normalizeConcept(basename(relPath, ".md").replace(/-/g, " ")), page);
  }
  return pages;
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

function buildSynthesisPrompt(page: KnowledgePage, facts: CompressedFact[]): string {
  return [
    "Synthesize this knowledge page from pre-compressed facts.",
    "Use only the facts below. Never infer from raw transcripts; raw transcripts are not provided.",
    "Return only JSON: {\"body\": string}.",
    "Preserve existing substantive content and integrate new facts into one coherent article.",
    "Do not add dated update sections.",
    "",
    `Path: ${page.relPath}`,
    "",
    "Current frontmatter:",
    "```json",
    JSON.stringify(page.frontmatter, null, 2),
    "```",
    "",
    "Current page body:",
    "```markdown",
    page.body.trim(),
    "```",
    "",
    "Compressed facts:",
    "```json",
    JSON.stringify(facts.map((fact) => ({
      title: fact.title,
      facts: fact.facts,
      narrative: fact.narrative,
      concepts: fact.concepts,
      files: fact.files,
      importance: fact.importance,
      sessionId: fact.sessionId,
      observedAt: fact.observedAt,
    })), null, 2),
    "```",
  ].join("\n");
}

async function chatWithTimeout(llm: LLMProvider, prompt: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await llm.chat({
      messages: [
        { role: "system", content: "Return only JSON: {\"body\": string}." },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseSynthesisBody(content: string): string | null {
  const json = extractJsonObject(content);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { body?: unknown }).body === "string") {
      const body = (parsed as { body: string }).body.trim();
      return body.length > 0 ? body : null;
    }
  } catch {
    return null;
  }
  return null;
}

function extractJsonObject(content: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}
