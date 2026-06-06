import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import { readRelations, writeRelations, type RelationMap } from "../retrieval/relations.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";
import { kebabCase } from "../storage/slug.js";
import type { ConsolidationFact } from "./filter-noise.js";

export const NARRATIVE_KNOWLEDGE_TYPES = [
  "projects",
  "lessons",
  "decisions",
  "references",
  "tools",
  "people",
  "procedures",
  "prospective",
] as const;

export type NarrativeKnowledgeType = typeof NARRATIVE_KNOWLEDGE_TYPES[number];

export type SynthesisOutcome = "rewritten" | "unchanged" | "staged-for-review";

export interface SynthesisResult {
  outcome: SynthesisOutcome;
  path: string;
  proposed: boolean;
  proposedPath?: string;
  reason?: string;
  tokensUsed?: LLMTokenUsage;
}

export interface SynthesizeNarrativeOptions {
  vaultRoot: string;
  pageRelPath: string;
  facts: ConsolidationFact[];
  llm: LLMProvider;
  now: Date;
}

interface NarrativeDetectOutput {
  contradicted_claims: string[];
  net_new_facts: string[];
}

interface NarrativeSynthesisOutput {
  body: string;
}

export const NARRATIVE_DETECT_SYSTEM_PROMPT = [
  "You are a memory novelty detector for narrative memory records.",
  "Return only JSON that identifies contradicted existing claims and net-new facts.",
  "Use the current frontmatter, current body, and accepted compressed facts only.",
].join("\n");

export const NARRATIVE_SYNTHESIS_SYSTEM_PROMPT = [
  "You are a memory consolidation engine. You write ONE narrative paragraph (or a short sequence of paragraphs) that updates the CURRENT BODY by:",
  "",
  "1. REMOVING the listed contradicted_claims wherever they appear (do not preserve, paraphrase, or rephrase them).",
  "2. INTEGRATING the listed net_new_facts inline as natural prose.",
  "3. PRESERVING all other substantive content verbatim or paraphrased.",
  "",
  "Rules:",
  "- Output ONLY prose. No `## headings`, no `- bullets`, no `[x] checkboxes`, no ``` code fences ```, no tables.",
  "- Wikilinks `[[target]]` inline are allowed.",
  "- Do not add \"Additional Information\", appendices, changelogs, or commentary.",
  "- Do not write metadata, IDs, dates, version numbers, or workflow content. Code handles those.",
].join("\n");

const DETECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["contradicted_claims", "net_new_facts"],
  properties: {
    contradicted_claims: { type: "array", items: { type: "string" } },
    net_new_facts: { type: "array", items: { type: "string" } },
  },
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: { type: "string" },
  },
};

export async function synthesizeNarrative(opts: SynthesizeNarrativeOptions): Promise<SynthesisResult> {
  const fullPath = safeResolveUnder(opts.vaultRoot, opts.pageRelPath);
  if (!fullPath || !existsSync(fullPath)) {
    throw new Error(`narrative synthesis: page not found: ${opts.pageRelPath}`);
  }
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  const detectResponse = await opts.llm.chat({
    messages: [
      {
        role: "system",
        content: NARRATIVE_DETECT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildDetectPrompt(opts.pageRelPath, parsed.frontmatter, parsed.body, opts.facts),
      },
    ],
    temperature: 0,
    jsonSchema: { name: "NarrativeDetectOutput", schema: DETECT_SCHEMA, strict: true },
  });
  let tokensUsed = detectResponse.tokensUsed;
  const detect = parseDetectOutput(detectResponse.content);

  if (detect.contradicted_claims.length === 0 && detect.net_new_facts.length === 0) {
    const baseFrontmatter = { ...parsed.frontmatter, updated: isoDate(opts.now) };
    const relationFrontmatter = await applyFactRelationsToFrontmatter(
      opts.vaultRoot,
      opts.pageRelPath,
      baseFrontmatter,
      opts.facts,
    );
    if (relationFrontmatter !== baseFrontmatter) {
      await atomicWrite(fullPath, serializeFrontmatter(relationFrontmatter, parsed.body));
      return { outcome: "rewritten", path: opts.pageRelPath, proposed: false, tokensUsed };
    }
    return { outcome: "unchanged", path: opts.pageRelPath, proposed: false, tokensUsed };
  }
  if (detect.contradicted_claims.length >= 10) {
    const proposedPath = await stageNarrativeReview(opts.vaultRoot, opts.pageRelPath, {
      reason: "too many contradicted claims for automatic rewrite",
      contradicted_claims: detect.contradicted_claims,
      net_new_facts: detect.net_new_facts,
      facts: opts.facts,
    }, opts.now);
    return {
      outcome: "staged-for-review",
      path: opts.pageRelPath,
      proposed: true,
      proposedPath,
      reason: "too many contradicted claims for automatic rewrite",
      tokensUsed,
    };
  }

  const synthResponse = await opts.llm.chat({
    messages: [
      {
        role: "system",
        content: NARRATIVE_SYNTHESIS_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildSynthesisPrompt(opts.pageRelPath, parsed.frontmatter, parsed.body, opts.facts, detect),
      },
    ],
    temperature: 0.2,
    jsonSchema: { name: "NarrativeSynthesisOutput", schema: SYNTHESIS_SCHEMA, strict: true },
  });
  tokensUsed = addTokenUsage(tokensUsed, synthResponse.tokensUsed);
  const synth = parseSynthesisOutput(synthResponse.content);

  const body = normalizeBody(synth.body);
  const validation = validateNarrativeBody(body);
  if (!validation.ok) {
    const proposedPath = await stageNarrativeReview(opts.vaultRoot, opts.pageRelPath, {
      reason: validation.reason,
      body,
      facts: opts.facts,
    }, opts.now);
    return { outcome: "staged-for-review", path: opts.pageRelPath, proposed: true, proposedPath, reason: validation.reason, tokensUsed };
  }
  const wikilinkCheck = validateWikilinkRetention(parsed.body, body);
  if (!wikilinkCheck.ok) {
    const proposedPath = await stageNarrativeReview(opts.vaultRoot, opts.pageRelPath, {
      reason: wikilinkCheck.reason,
      body,
      facts: opts.facts,
    }, opts.now);
    return { outcome: "staged-for-review", path: opts.pageRelPath, proposed: true, proposedPath, reason: wikilinkCheck.reason, tokensUsed };
  }
  if (narrativeEquivalent(parsed.body, body)) {
    return { outcome: "unchanged", path: opts.pageRelPath, proposed: false, tokensUsed };
  }

  const history = await archivePageVersion(opts.vaultRoot, opts.pageRelPath, current, opts.now, parsed.frontmatter);
  const nextFrontmatter = await applyFactRelationsToFrontmatter(
    opts.vaultRoot,
    opts.pageRelPath,
    nextNarrativeFrontmatter(parsed.frontmatter, opts.now, opts.facts, history),
    opts.facts,
  );
  await atomicWrite(fullPath, serializeFrontmatter(nextFrontmatter, `${body}\n`));
  return { outcome: "rewritten", path: opts.pageRelPath, proposed: false, tokensUsed };
}

export function isNarrativeKnowledgePageType(value: unknown): value is NarrativeKnowledgeType {
  return typeof value === "string" && NARRATIVE_KNOWLEDGE_TYPES.includes(value as NarrativeKnowledgeType);
}

export function isNarrativeKnowledgePagePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const match = /^wiki\/([^/.][^/]*)\/[^/]+\.md$/u.exec(normalized);
  return Boolean(match?.[1] && isNarrativeKnowledgePageType(match[1]));
}

export function validateNarrativeBody(body: string): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizeBody(body);
  if (normalized.length === 0) return { ok: false, reason: "body is empty" };
  if (/^#{1,6}\s+/mu.test(normalized)) return { ok: false, reason: "narrative body must not contain headings" };
  if (/^\s*[-*+]\s+/mu.test(normalized)) return { ok: false, reason: "narrative body must not contain lists" };
  if (/^\s*\d+\.\s+/mu.test(normalized)) return { ok: false, reason: "narrative body must not contain lists" };
  if (/```/u.test(normalized)) return { ok: false, reason: "narrative body must not contain code fences" };
  if (/^\s*\|.+\|\s*$/mu.test(normalized)) return { ok: false, reason: "narrative body must not contain tables" };
  return { ok: true };
}

export async function archivePageVersion(
  vaultRoot: string,
  pageRelPath: string,
  content: string,
  now: Date,
  frontmatter?: Record<string, unknown>,
): Promise<{ path: string; hash: string; version: number | null }> {
  const historyRelPath = `wiki/.history/${pageRelPath}/${timestampForPath(now)}.md`;
  const historyFullPath = safeResolveUnder(vaultRoot, historyRelPath);
  if (!historyFullPath) throw new Error(`invalid history path for ${pageRelPath}`);
  await mkdir(dirname(historyFullPath), { recursive: true });
  await atomicWrite(historyFullPath, content);
  const version = typeof frontmatter?.version === "number" ? frontmatter.version : null;
  return { path: historyRelPath, hash: sha256(content), version };
}

export async function stageNarrativeReview(
  vaultRoot: string,
  pageRelPath: string,
  packet: unknown,
  now: Date = new Date(),
): Promise<string> {
  const proposedRelPath = `wiki/compile-proposed/${basename(pageRelPath)}`;
  const fullPath = safeResolveUnder(vaultRoot, proposedRelPath);
  if (!fullPath) throw new Error(`invalid proposed path for ${pageRelPath}`);
  const sourceFullPath = safeResolveUnder(vaultRoot, pageRelPath);
  if (!sourceFullPath || !existsSync(sourceFullPath)) throw new Error(`narrative review source missing: ${pageRelPath}`);
  const current = parseFrontmatter(await readFile(sourceFullPath, "utf-8"));
  const record = asRecord(packet);
  const proposedBody = typeof record.body === "string" && record.body.trim().length > 0
    ? normalizeBody(record.body)
    : normalizeBody(current.body);
  const reason = typeof record.reason === "string" && record.reason.trim().length > 0
    ? record.reason.trim()
    : "narrative synthesis staged for review";
  const reviewMetadata: Record<string, unknown> = {
    path: pageRelPath,
    ...record,
  };
  delete reviewMetadata.body;
  await mkdir(dirname(fullPath), { recursive: true });
  await atomicWrite(
    fullPath,
    serializeFrontmatter(
      {
        type: "references",
        title: `compile proposal: ${pageRelPath}`,
        created: isoDate(now),
        updated: isoDate(now),
        status: "active",
        lifecycle: "proposed",
        source: "compile-execute",
        cognitive_type: "semantic",
      },
      [
        `# Compile proposal: ${pageRelPath}`,
        "",
        `Reason: ${reason}`,
        "",
        "```compile-op",
        stringifyFencedJson({
          kind: "rewrite_page",
          path: pageRelPath,
          body: proposedBody,
        }),
        "```",
        "",
        "Review metadata:",
        "",
        "```json",
        stringifyFencedJson(reviewMetadata),
        "```",
        "",
      ].join("\n"),
    ),
  );
  return proposedRelPath;
}

export async function moveToArchive(vaultRoot: string, relPath: string, archiveDate: string): Promise<{ from: string; to: string }> {
  const from = safeResolveUnder(vaultRoot, relPath);
  if (!from || !existsSync(from)) throw new Error(`archive source missing: ${relPath}`);
  const toRelPath = `wiki/.archive/${archiveDate}/${relPath}`;
  const to = safeResolveUnder(vaultRoot, toRelPath);
  if (!to) throw new Error(`invalid archive target: ${toRelPath}`);
  if (existsSync(to)) throw new Error(`archive target already exists: ${toRelPath}`);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return { from: relPath, to: toRelPath };
}

export function nextNarrativeFrontmatter(
  current: Frontmatter,
  now: Date,
  facts: ConsolidationFact[],
  history: { path: string; hash: string; version: number | null },
): Frontmatter {
  const currentVersion = typeof current.version === "number" ? current.version : 1;
  const previousSupersedes = Array.isArray(current.supersedes) ? current.supersedes : [];
  return {
    ...current,
    updated: isoDate(now),
    version: currentVersion + 1,
    supersedes: [...previousSupersedes, history],
    strength: typeof current.strength === "number" ? current.strength : 8,
    last_accessed: isoDate(now),
    source_facts: facts.map((fact) => fact.fact_id),
  };
}

async function applyFactRelationsToFrontmatter(
  vaultRoot: string,
  pageRelPath: string,
  frontmatter: Frontmatter,
  facts: ConsolidationFact[],
): Promise<Frontmatter> {
  const triples = facts.flatMap((fact) => {
    const factRecord = fact.fact;
    return typeof factRecord === "object" && factRecord !== null && Array.isArray(factRecord.relations)
      ? factRecord.relations
      : [];
  });
  if (triples.length === 0) return frontmatter;

  const resolver = await buildWikiEntityResolver(vaultRoot);
  const pageKeys = pageIdentityKeys(pageRelPath, frontmatter.title);
  const relations: RelationMap = readRelations(frontmatter.relations, pageRelPath);
  let changed = false;

  for (const triple of triples) {
    if (!pageKeys.has(normalizeEntityKey(triple.subject))) continue;
    const target = resolver(triple.object);
    if (!target || target === pageRelPath) continue;
    const relationType = normalizeRelationType(triple.predicate);
    if (!relationType) continue;
    const bucket = relations[relationType] ?? [];
    if (bucket.some((edge) => edge.target === target)) continue;
    relations[relationType] = [...bucket, { target }];
    changed = true;
  }

  return changed
    ? { ...frontmatter, relations: writeRelations(relations) }
    : frontmatter;
}

async function buildWikiEntityResolver(vaultRoot: string): Promise<(entity: string) => string | null> {
  const index = new Map<string, Set<string>>();
  const wikiRoot = join(vaultRoot, "wiki");
  if (!existsSync(wikiRoot)) return () => null;
  for (const fullPath of await listWikiEntityPages(wikiRoot)) {
    const relPath = `wiki/${relative(wikiRoot, fullPath).replace(/\\/g, "/")}`;
    const parsed = parseFrontmatter(await readFile(fullPath, "utf-8"));
    for (const key of pageIdentityKeys(relPath, typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : "")) {
      const bucket = index.get(key) ?? new Set<string>();
      bucket.add(relPath);
      index.set(key, bucket);
    }
  }

  return (entity: string): string | null => {
    const key = normalizeEntityKey(entity);
    const exact = index.get(key);
    if (exact?.size === 1) return [...exact][0]!;
    if (exact && exact.size > 1) return null;
    const fuzzy = [...index.entries()]
      .filter(([candidate]) => levenshtein(candidate, key) <= 2)
      .flatMap(([, paths]) => [...paths]);
    const unique = [...new Set(fuzzy)];
    return unique.length === 1 ? unique[0]! : null;
  };
}

async function listWikiEntityPages(wikiRoot: string): Promise<string[]> {
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

function pageIdentityKeys(relPath: string, title: string): Set<string> {
  const slug = basename(relPath, ".md").replace(/-/g, " ");
  return new Set([title, slug, relPath, relPath.replace(/^wiki\/[^/]+\//, "").replace(/\.md$/, "")].map(normalizeEntityKey).filter(Boolean));
}

function normalizeEntityKey(value: string): string {
  return kebabCase(value).replace(/-/g, " ").trim().toLowerCase();
}

function normalizeRelationType(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const aliases: Record<string, string> = {
    "derived-from": "derived_from",
    "depends-on": "depends_on",
    "caused-by": "caused_by",
    "fixed-by": "fixed_by",
    "learned-from": "learned_from",
    "mentioned-in": "mentioned_in",
    "tested-with": "tested-with",
  };
  return aliases[normalized] ?? (normalized || null);
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

function buildDetectPrompt(
  pageRelPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  facts: ConsolidationFact[],
): string {
  return [
    "Compare the current narrative memory record against the accepted compressed facts.",
    "Return contradicted existing claims and net-new facts only.",
    `Path: ${pageRelPath}`,
    "",
    "Frontmatter:",
    JSON.stringify(frontmatter, null, 2),
    "",
    "Current body:",
    body.trim(),
    "",
    "Facts:",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

function buildSynthesisPrompt(
  pageRelPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
  facts: ConsolidationFact[],
  detect: NarrativeDetectOutput,
): string {
  return [
    "Rewrite this knowledge page as a single narrative memory record.",
    "Preserve all still-true substantive content, remove contradicted claims, and integrate net-new facts.",
    "Hard rules: no Markdown headings, no bullets or numbered lists, no checklists, no tables, no code fences.",
    "Inline wikilinks are allowed and existing wikilinks should be retained when still relevant.",
    `Path: ${pageRelPath}`,
    "",
    "Current frontmatter:",
    JSON.stringify(frontmatter, null, 2),
    "",
    "Current body:",
    body.trim(),
    "",
    "Contradicted claims:",
    JSON.stringify(detect.contradicted_claims, null, 2),
    "",
    "Net-new facts:",
    JSON.stringify(detect.net_new_facts, null, 2),
    "",
    "Accepted fact records:",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

function parseDetectOutput(content: string): NarrativeDetectOutput {
  const parsed = parseJsonObject(content) as Partial<NarrativeDetectOutput>;
  return {
    contradicted_claims: stringArray(parsed.contradicted_claims),
    net_new_facts: stringArray(parsed.net_new_facts),
  };
}

function parseSynthesisOutput(content: string): NarrativeSynthesisOutput {
  const parsed = parseJsonObject(content) as Partial<NarrativeSynthesisOutput>;
  if (typeof parsed.body !== "string" || parsed.body.trim().length === 0) {
    throw new Error("narrative synthesis: LLM returned no body");
  }
  return { body: parsed.body };
}

function parseJsonObject(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/mu.exec(content)?.[1]?.trim();
  const raw = fenced ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  if (!raw || raw.length === 0) throw new Error("narrative synthesis: LLM returned invalid JSON");
  return JSON.parse(raw) as unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function validateWikilinkRetention(currentBody: string, nextBody: string): { ok: true } | { ok: false; reason: string } {
  const existing = Array.from(currentBody.matchAll(/\[\[[^\]]+\]\]/gu)).map((match) => match[0]!);
  if (existing.length === 0) return { ok: true };
  const missing = existing.filter((link) => !nextBody.includes(link));
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: `synthesized body dropped wikilinks: ${missing.join(", ")}` };
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function narrativeEquivalent(a: string, b: string): boolean {
  return normalizeBody(a) === normalizeBody(b) || normalizeForComparison(a) === normalizeForComparison(b);
}

function normalizeForComparison(text: string): string {
  return text
    .replace(/^#+\s+/gmu, "")
    .replace(/[`*_~[\]()#>:.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function safeResolveUnder(root: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (isAbsolute(normalized) || normalized.startsWith("../")) return null;
  const finalPath = resolve(root, ...normalized.split("/"));
  const rel = relative(resolve(root), finalPath);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? finalPath : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function stringifyFencedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/```/gu, "\\u0060\\u0060\\u0060");
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function addTokenUsage(left: LLMTokenUsage | undefined, right: LLMTokenUsage | undefined): LLMTokenUsage | undefined {
  if (!right) return left;
  return {
    prompt: (left?.prompt ?? 0) + right.prompt,
    completion: (left?.completion ?? 0) + right.completion,
    total: (left?.total ?? 0) + right.total,
  };
}
