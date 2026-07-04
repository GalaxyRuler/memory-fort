import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "../../storage/frontmatter.js";
import { isWikiDotDirectoryPath } from "../../retrieval/wiki-paths.js";
import { normalizeEvidenceId } from "../longmemeval/scoring.js";
import type { RetrievalGoldType } from "./types.js";

export type Phase5RecallCandidateCategory =
  | "known-target"
  | "ambiguous"
  | "code-api"
  | "metadata-path-heavy"
  | "graph-hyde-favoring";

export type Phase5RecallLabelStatus = "needs-user-confirmation" | "confirmed";
export type Phase5RecallQueryVariant = "original" | "held-out" | "hard-held-out";

export interface Phase5RecallCandidateEvidence {
  readonly path: string;
  readonly title: string;
  readonly heading?: string;
}

export interface Phase5RecallCandidate {
  readonly id: string;
  readonly query: string;
  readonly heldOutQueries?: readonly string[];
  readonly hardHeldOutQueries?: readonly string[];
  readonly category: Phase5RecallCandidateCategory;
  readonly type: RetrievalGoldType;
  readonly suggestedExpectedPaths: readonly string[];
  readonly labelStatus: Phase5RecallLabelStatus;
  readonly source: "existing-gold" | "vault";
  readonly reason: string;
  readonly evidence: readonly Phase5RecallCandidateEvidence[];
}

export interface ScaffoldPhase5RecallCandidatesOptions {
  readonly vaultRoot: string;
  readonly goldPaths?: readonly string[];
  readonly maxCandidates?: number;
}

export interface Phase5JudgedQuery {
  readonly id: string;
  readonly query: string;
  readonly held_out_queries?: readonly string[];
  readonly heldOutQueries?: readonly string[];
  readonly hard_held_out_queries?: readonly string[];
  readonly hardHeldOutQueries?: readonly string[];
  readonly category: Phase5RecallCandidateCategory;
  readonly type: RetrievalGoldType;
  readonly expected_paths: readonly string[];
}

export interface Phase5RecallSearchInput {
  readonly query: string;
  readonly limit: number;
}

export interface Phase5RecallSearchResult {
  readonly results: readonly Phase5RecallSearchHit[];
  readonly latencyMs: number;
  readonly warnings: readonly string[];
}

export interface Phase5RecallSearchHit {
  readonly path: string;
  readonly rank?: number;
}

export type Phase5RecallSearchFn = (input: Phase5RecallSearchInput) => Promise<Phase5RecallSearchResult>;

export type Phase5RecallDtype = "binary" | "int8" | "float32";

export interface Phase5RecallSearchers {
  readonly legacy: Phase5RecallSearchFn;
  readonly indexHybrid: Phase5RecallSearchFn;
  readonly indexLexical: Phase5RecallSearchFn;
  readonly dtypes?: Partial<Record<Phase5RecallDtype, Phase5RecallSearchFn>>;
}

export interface Phase5LocalVectorProfile {
  readonly provider: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly dtype: string;
}

export interface RunPhase5RecallEvaluationOptions {
  readonly vaultRoot: string;
  readonly indexDbPath: string;
  readonly judgedQueries: readonly Phase5JudgedQuery[];
  readonly searchers: Phase5RecallSearchers;
  readonly localVectorProfile?: Phase5LocalVectorProfile | null;
  readonly materialRecallDelta?: number;
}

export interface Phase5RecallEvaluationReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly vaultRoot: string;
  readonly indexDbPath: string;
  readonly judgedQueryCount: number;
  readonly originalJudgedQueryCount: number;
  readonly heldOutQueryCount: number;
  readonly hardHeldOutQueryCount: number;
  readonly gates: Phase5RecallGates;
  readonly perQuery: readonly Phase5RecallPerQueryResult[];
}

export interface Phase5RecallGates {
  readonly A: Phase5GateA;
  readonly B: Phase5GateB;
  readonly C: Phase5GateC;
  readonly D: Phase5GateD;
  readonly F: Phase5GateF;
  readonly G?: Phase5GateG;
}

export interface Phase5GateA {
  readonly queryCount: number;
  readonly top1Rate: number;
  readonly top3Rate: number;
  readonly misses: readonly Phase5KnownTargetMiss[];
}

export interface Phase5KnownTargetMiss {
  readonly id: string;
  readonly query: string;
  readonly expected: readonly string[];
  readonly retrieved: readonly string[];
}

export interface Phase5GateB {
  readonly top5: Phase5OverlapSummary;
  readonly top10: Phase5OverlapSummary;
  readonly disagreements: readonly Phase5OverlapDisagreement[];
}

export interface Phase5OverlapSummary {
  readonly meanOverlapCount: number;
  readonly meanOverlapRate: number;
}

export interface Phase5OverlapDisagreement {
  readonly id: string;
  readonly query: string;
  readonly legacyOnly: readonly string[];
  readonly hybridOnly: readonly string[];
}

export interface Phase5GateC {
  readonly hybridRecallAt10: number;
  readonly lexicalRecallAt10: number;
  readonly delta: number;
  readonly hybridBeatsLexical: boolean;
}

export interface Phase5GateD {
  readonly localBgeSmallMeasured: boolean;
  readonly profile: Phase5LocalVectorProfile | null;
}

export interface Phase5GateF {
  readonly hybridRecallAt10: number;
  readonly legacyRecallAt10: number;
  readonly delta: number;
  readonly verdict: "candidate-cutover-ready" | "phase6-review-required";
}

export interface Phase5GateG {
  readonly recallAt10: Record<Phase5RecallDtype, number>;
  readonly recallAt20: Record<Phase5RecallDtype, number>;
  readonly recommendedDtype: Phase5RecallDtype;
  readonly reason: string;
}

export interface Phase5RecallPerQueryResult {
  readonly id: string;
  readonly query: string;
  readonly queryVariant: Phase5RecallQueryVariant;
  readonly parentId?: string;
  readonly category: Phase5RecallCandidateCategory;
  readonly expected: readonly string[];
  readonly legacy: readonly string[];
  readonly indexHybrid: readonly string[];
  readonly indexLexical: readonly string[];
  readonly dtypes?: Partial<Record<Phase5RecallDtype, readonly string[]>>;
}

interface ExpandedPhase5JudgedQuery extends Phase5JudgedQuery {
  readonly queryVariant: Phase5RecallQueryVariant;
  readonly parentId?: string;
}

interface VaultPage {
  readonly relPath: string;
  readonly title: string;
  readonly type: string;
  readonly updated?: string;
  readonly body: string;
  readonly headings: readonly string[];
}

const CANDIDATE_CATEGORY_ORDER: readonly Phase5RecallCandidateCategory[] = [
  "known-target",
  "ambiguous",
  "code-api",
  "metadata-path-heavy",
  "graph-hyde-favoring",
];

const DTYPE_ORDER: readonly Phase5RecallDtype[] = ["binary", "int8", "float32"];
const DEFAULT_MAX_CANDIDATES = 75;
const DEFAULT_MATERIAL_RECALL_DELTA = 0.02;

export async function scaffoldPhase5RecallCandidates(
  opts: ScaffoldPhase5RecallCandidatesOptions,
): Promise<Phase5RecallCandidate[]> {
  const vaultRoot = resolve(opts.vaultRoot);
  const candidates: Phase5RecallCandidate[] = [];
  for (const goldPath of opts.goldPaths ?? []) {
    candidates.push(...await candidatesFromGold(goldPath, vaultRoot));
  }

  const pages = await loadVaultPages(vaultRoot);
  for (const page of pages) {
    candidates.push(...candidatesFromPage(page));
  }

  return capAndBalanceCandidates(dedupeCandidates(candidates), opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
}

export function serializePhase5RecallCandidatesJsonl(
  candidates: readonly Phase5RecallCandidate[],
): string {
  return `${candidates.map((candidate) => JSON.stringify(candidate)).join("\n")}\n`;
}

export function formatPhase5RecallCandidatesMarkdown(
  candidates: readonly Phase5RecallCandidate[],
  opts: { readonly vaultRoot: string; readonly generatedAt?: string },
): string {
  const lines = [
    "# Phase 5 Task 5a Candidate Judged Queries",
    "",
    `Generated: ${opts.generatedAt ?? new Date().toISOString()}`,
    `Vault: ${redactLocalPath(opts.vaultRoot)}`,
    "",
    "Confirm or correct `suggestedExpectedPaths` before gates G/A/B/C/D/F are run.",
    "",
    "| id | category | query | held-out queries | hard held-out queries | suggested expected paths | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const candidate of candidates) {
    lines.push([
      candidate.id,
      candidate.category,
      markdownCell(candidate.query),
      markdownCell((candidate.heldOutQueries ?? []).join("<br>")),
      markdownCell((candidate.hardHeldOutQueries ?? []).join("<br>")),
      markdownCell(candidate.suggestedExpectedPaths.join("<br>")),
      markdownCell(candidate.evidence.map((entry) => `${entry.path} (${entry.title})`).join("<br>")),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  return `${lines.join("\n")}\n`;
}

export async function writePhase5RecallCandidateFiles(opts: {
  readonly candidates: readonly Phase5RecallCandidate[];
  readonly jsonlPath: string;
  readonly markdownPath: string;
  readonly vaultRoot: string;
  readonly generatedAt?: string;
}): Promise<void> {
  await mkdir(dirname(opts.jsonlPath), { recursive: true });
  await mkdir(dirname(opts.markdownPath), { recursive: true });
  await writeFile(opts.jsonlPath, serializePhase5RecallCandidatesJsonl(opts.candidates), "utf8");
  await writeFile(
    opts.markdownPath,
    formatPhase5RecallCandidatesMarkdown(opts.candidates, {
      vaultRoot: opts.vaultRoot,
      generatedAt: opts.generatedAt,
    }),
    "utf8",
  );
}

export async function runPhase5RecallEvaluation(
  opts: RunPhase5RecallEvaluationOptions,
): Promise<Phase5RecallEvaluationReport> {
  const startedAt = new Date().toISOString();
  const perQuery: Phase5RecallPerQueryResult[] = [];
  const queries = expandHeldOutQueries(opts.judgedQueries);

  for (const query of queries) {
    const [legacy, hybrid, lexical] = await Promise.all([
      opts.searchers.legacy({ query: query.query, limit: 20 }),
      opts.searchers.indexHybrid({ query: query.query, limit: 20 }),
      opts.searchers.indexLexical({ query: query.query, limit: 20 }),
    ]);
    const dtypeResults: Partial<Record<Phase5RecallDtype, readonly string[]>> = {};
    for (const dtype of DTYPE_ORDER) {
      const search = opts.searchers.dtypes?.[dtype];
      if (search) {
        dtypeResults[dtype] = pathsFromSearchResult(await search({ query: query.query, limit: 20 }));
      }
    }
    perQuery.push({
      id: query.id,
      query: query.query,
      queryVariant: query.queryVariant,
      ...(query.parentId ? { parentId: query.parentId } : {}),
      category: query.category,
      expected: query.expected_paths,
      legacy: pathsFromSearchResult(legacy),
      indexHybrid: pathsFromSearchResult(hybrid),
      indexLexical: pathsFromSearchResult(lexical),
      ...(Object.keys(dtypeResults).length > 0 ? { dtypes: dtypeResults } : {}),
    });
  }

  const gates: Phase5RecallGates = {
    A: gateA(perQuery),
    B: gateB(perQuery),
    C: gateC(perQuery),
    D: gateD(opts.localVectorProfile ?? null),
    F: gateF(perQuery, opts.materialRecallDelta ?? DEFAULT_MATERIAL_RECALL_DELTA),
    ...(hasDtypeResults(perQuery) ? { G: gateG(perQuery, opts.materialRecallDelta ?? DEFAULT_MATERIAL_RECALL_DELTA) } : {}),
  };

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    vaultRoot: opts.vaultRoot,
    indexDbPath: opts.indexDbPath,
    judgedQueryCount: queries.length,
    originalJudgedQueryCount: opts.judgedQueries.length,
    heldOutQueryCount: queries.filter((query) => query.queryVariant === "held-out").length,
    hardHeldOutQueryCount: queries.filter((query) => query.queryVariant === "hard-held-out").length,
    gates,
    perQuery,
  };
}

async function candidatesFromGold(goldPath: string, vaultRoot: string): Promise<Phase5RecallCandidate[]> {
  if (!existsSync(goldPath)) return [];
  const rows = (await readFile(goldPath, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return rows.flatMap((row): Phase5RecallCandidate[] => {
    const query = readString(row["query"]);
    const expected = readStringArray(row["expected_paths"]);
    const heldOutQueries = [
      ...readStringArray(row["held_out_queries"]),
      ...readStringArray(row["heldOutQueries"]),
    ];
    const hardHeldOutQueries = [
      ...readStringArray(row["hard_held_out_queries"]),
      ...readStringArray(row["hardHeldOutQueries"]),
    ];
    const type = readGoldType(row["type"]);
    if (!query || expected.length === 0) return [];
    return [makeCandidate({
      query,
      ...(heldOutQueries.length > 0 ? { heldOutQueries } : {}),
      ...(hardHeldOutQueries.length > 0 ? { hardHeldOutQueries } : {}),
      category: "known-target",
      type,
      suggestedExpectedPaths: expected,
      source: "existing-gold",
      reason: `Seeded from ${normalizePath(relative(process.cwd(), goldPath))}`,
      evidence: expected.map((path) => ({
        path,
        title: titleFromPath(path, vaultRoot),
      })),
    })];
  });
}

async function loadVaultPages(vaultRoot: string): Promise<VaultPage[]> {
  const wikiRoot = join(vaultRoot, "wiki");
  const files = await listMarkdownFiles(wikiRoot, vaultRoot);
  const pages: VaultPage[] = [];
  for (const fullPath of files) {
    const relPath = normalizePath(relative(vaultRoot, fullPath));
    if (isRecallScaffoldExcludedPath(relPath)) continue;
    const content = await readFile(fullPath, "utf8");
    const parsed = parseVaultPage(content, relPath);
    if (parsed) pages.push(parsed);
  }
  return pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function listMarkdownFiles(root: string, vaultRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = normalizePath(relative(vaultRoot, fullPath));
      if (entry.isDirectory()) {
        if (isRecallScaffoldExcludedPath(relPath)) continue;
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (isRecallScaffoldExcludedPath(relPath)) continue;
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function parseVaultPage(content: string, relPath: string): VaultPage | null {
  try {
    const parsed = parseFrontmatter(content);
    const title = readString(parsed.frontmatter.title) ?? titleFromPath(relPath);
    return {
      relPath,
      title,
      type: readString(parsed.frontmatter.type) ?? typeFromPath(relPath),
      updated: readString(parsed.frontmatter.updated) ?? undefined,
      body: parsed.body,
      headings: extractHeadings(parsed.body),
    };
  } catch {
    return {
      relPath,
      title: titleFromPath(relPath),
      type: typeFromPath(relPath),
      body: content,
      headings: extractHeadings(content),
    };
  }
}

function candidatesFromPage(page: VaultPage): Phase5RecallCandidate[] {
  const candidates: Phase5RecallCandidate[] = [];
  const evidence = [{
    path: page.relPath,
    title: page.title,
    ...(page.headings[0] ? { heading: page.headings[0] } : {}),
  }];
  candidates.push(makeCandidate({
    query: `what happened with ${shortTitle(page.title)}`,
    category: "ambiguous",
    type: page.type === "threads" ? "temporal" : "fact",
    suggestedExpectedPaths: [page.relPath],
    source: "vault",
    reason: "Short title query is intentionally ambiguous and needs human label confirmation.",
    evidence,
  }));

  const codeToken = firstCodeOrApiToken(page.body);
  if (codeToken) {
    candidates.push(makeCandidate({
      query: `which note mentions ${codeToken}`,
      category: "code-api",
      type: "dependency",
      suggestedExpectedPaths: [page.relPath],
      source: "vault",
      reason: "Page contains code/API-shaped text.",
      evidence,
    }));
  }

  if (isMetadataPathHeavy(page)) {
    candidates.push(makeCandidate({
      query: `which ${page.type} note at ${pathWords(page.relPath)} covers ${page.title}`,
      category: "metadata-path-heavy",
      type: page.type === "threads" ? "temporal" : "provenance",
      suggestedExpectedPaths: [page.relPath],
      source: "vault",
      reason: "Path, type, or date metadata is part of the query.",
      evidence,
    }));
  }

  if (looksGraphOrHydeFavoring(page)) {
    candidates.push(makeCandidate({
      query: `what does ${page.title} connect to or derive from`,
      category: "graph-hyde-favoring",
      type: "provenance",
      suggestedExpectedPaths: [page.relPath],
      source: "vault",
      reason: "Page has link/provenance signals where graph, HyDE, or rerank may help.",
      evidence,
    }));
  }

  return candidates;
}

function makeCandidate(input: Omit<Phase5RecallCandidate, "id" | "labelStatus">): Phase5RecallCandidate {
  return {
    id: `p5-${hashId([input.category, input.query, ...input.suggestedExpectedPaths].join("\0"))}`,
    labelStatus: "needs-user-confirmation",
    ...input,
  };
}

function expandHeldOutQueries(
  judgedQueries: readonly Phase5JudgedQuery[],
): ExpandedPhase5JudgedQuery[] {
  return judgedQueries.flatMap((query): ExpandedPhase5JudgedQuery[] => [
    {
      ...query,
      queryVariant: "original",
    },
    ...[
      ...readStringArray(query.held_out_queries),
      ...readStringArray(query.heldOutQueries),
    ].map((heldOutQuery, index): ExpandedPhase5JudgedQuery => ({
      ...query,
      id: `${query.id}:heldout:${index + 1}`,
      query: heldOutQuery,
      queryVariant: "held-out",
      parentId: query.id,
      held_out_queries: [],
      heldOutQueries: [],
      hard_held_out_queries: [],
      hardHeldOutQueries: [],
    })),
    ...[
      ...readStringArray(query.hard_held_out_queries),
      ...readStringArray(query.hardHeldOutQueries),
    ].map((heldOutQuery, index): ExpandedPhase5JudgedQuery => ({
      ...query,
      id: `${query.id}:hard-heldout:${index + 1}`,
      query: heldOutQuery,
      queryVariant: "hard-held-out",
      parentId: query.id,
      held_out_queries: [],
      heldOutQueries: [],
      hard_held_out_queries: [],
      hardHeldOutQueries: [],
    })),
  ]);
}

function dedupeCandidates(candidates: readonly Phase5RecallCandidate[]): Phase5RecallCandidate[] {
  const seen = new Set<string>();
  const deduped: Phase5RecallCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      normalizeQuery(candidate.query),
      candidate.category,
      candidate.suggestedExpectedPaths.map(normalizeEvidenceId).sort().join(","),
    ].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function capAndBalanceCandidates(
  candidates: readonly Phase5RecallCandidate[],
  maxCandidates: number,
): Phase5RecallCandidate[] {
  const max = Math.max(1, Math.trunc(maxCandidates));
  if (candidates.length <= max) return [...candidates];

  const selected: Phase5RecallCandidate[] = [];
  const selectedIds = new Set<string>();
  const add = (candidate: Phase5RecallCandidate | undefined): void => {
    if (!candidate || selectedIds.has(candidate.id) || selected.length >= max) return;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  };

  for (const candidate of candidates) {
    if (candidate.source === "existing-gold") add(candidate);
  }
  for (const category of CANDIDATE_CATEGORY_ORDER) {
    if (!selected.some((candidate) => candidate.category === category)) {
      add(candidates.find((candidate) => candidate.category === category));
    }
  }
  for (const candidate of candidates) add(candidate);
  return selected.slice(0, max);
}

function gateA(perQuery: readonly Phase5RecallPerQueryResult[]): Phase5GateA {
  const top1Hits = perQuery.filter((query) => containsExpected(query.expected, query.indexHybrid, 1));
  const top3Hits = perQuery.filter((query) => containsExpected(query.expected, query.indexHybrid, 3));
  return {
    queryCount: perQuery.length,
    top1Rate: rate(top1Hits.length, perQuery.length),
    top3Rate: rate(top3Hits.length, perQuery.length),
    misses: perQuery
      .filter((query) => !containsExpected(query.expected, query.indexHybrid, 3))
      .map((query) => ({
        id: query.id,
        query: query.query,
        expected: query.expected,
        retrieved: query.indexHybrid.slice(0, 3),
      })),
  };
}

function gateB(perQuery: readonly Phase5RecallPerQueryResult[]): Phase5GateB {
  return {
    top5: overlapSummary(perQuery, 5),
    top10: overlapSummary(perQuery, 10),
    disagreements: perQuery.flatMap((query): Phase5OverlapDisagreement[] => {
      const legacyTop = normalizedSet(query.legacy.slice(0, 10));
      const hybridTop = normalizedSet(query.indexHybrid.slice(0, 10));
      const legacyOnly = query.legacy.slice(0, 10).filter((path) => !hybridTop.has(normalizeEvidenceId(path)));
      const hybridOnly = query.indexHybrid.slice(0, 10).filter((path) => !legacyTop.has(normalizeEvidenceId(path)));
      return legacyOnly.length > 0 || hybridOnly.length > 0
        ? [{ id: query.id, query: query.query, legacyOnly, hybridOnly }]
        : [];
    }),
  };
}

function gateC(perQuery: readonly Phase5RecallPerQueryResult[]): Phase5GateC {
  const hybridRecallAt10 = mean(perQuery.map((query) => recallAtK(query.expected, query.indexHybrid, 10)));
  const lexicalRecallAt10 = mean(perQuery.map((query) => recallAtK(query.expected, query.indexLexical, 10)));
  const delta = round(hybridRecallAt10 - lexicalRecallAt10);
  return {
    hybridRecallAt10,
    lexicalRecallAt10,
    delta,
    hybridBeatsLexical: delta > 0,
  };
}

function gateD(profile: Phase5LocalVectorProfile | null): Phase5GateD {
  return {
    localBgeSmallMeasured: Boolean(
      profile &&
      profile.provider === "local" &&
      profile.modelId === "BAAI/bge-small-en-v1.5" &&
      profile.dimension === 384,
    ),
    profile,
  };
}

function gateF(perQuery: readonly Phase5RecallPerQueryResult[], materialDelta: number): Phase5GateF {
  const hybridRecallAt10 = mean(perQuery.map((query) => recallAtK(query.expected, query.indexHybrid, 10)));
  const legacyRecallAt10 = mean(perQuery.map((query) => recallAtK(query.expected, query.legacy, 10)));
  const delta = round(hybridRecallAt10 - legacyRecallAt10);
  return {
    hybridRecallAt10,
    legacyRecallAt10,
    delta,
    verdict: delta >= -materialDelta ? "candidate-cutover-ready" : "phase6-review-required",
  };
}

function gateG(perQuery: readonly Phase5RecallPerQueryResult[], materialDelta: number): Phase5GateG {
  const recallAt10 = dtypeRecall(perQuery, 10);
  const recallAt20 = dtypeRecall(perQuery, 20);
  const bestDtype = [...DTYPE_ORDER].sort((a, b) => recallAt20[b] - recallAt20[a])[0] ?? "binary";
  const recommendedDtype = recallAt20.binary >= recallAt20[bestDtype] - materialDelta ? "binary" : bestDtype;
  return {
    recallAt10,
    recallAt20,
    recommendedDtype,
    reason: recommendedDtype === "binary"
      ? "binary recall is within the material delta of the best dtype"
      : `binary recall trails ${recommendedDtype} by more than ${materialDelta}`,
  };
}

function overlapSummary(perQuery: readonly Phase5RecallPerQueryResult[], k: number): Phase5OverlapSummary {
  const counts = perQuery.map((query) => overlapCount(query.legacy, query.indexHybrid, k));
  return {
    meanOverlapCount: mean(counts),
    meanOverlapRate: mean(counts.map((count) => count / k)),
  };
}

function dtypeRecall(perQuery: readonly Phase5RecallPerQueryResult[], k: number): Record<Phase5RecallDtype, number> {
  return Object.fromEntries(DTYPE_ORDER.map((dtype) => {
    const values = perQuery.map((query) => recallAtK(query.expected, query.dtypes?.[dtype] ?? [], k));
    return [dtype, mean(values)];
  })) as Record<Phase5RecallDtype, number>;
}

function hasDtypeResults(perQuery: readonly Phase5RecallPerQueryResult[]): boolean {
  return perQuery.some((query) => query.dtypes && DTYPE_ORDER.some((dtype) => query.dtypes?.[dtype]));
}

function pathsFromSearchResult(result: Phase5RecallSearchResult): string[] {
  return result.results.map((hit) => hit.path);
}

function containsExpected(expected: readonly string[], retrieved: readonly string[], k: number): boolean {
  return recallAtK(expected, retrieved, k) > 0;
}

function recallAtK(expected: readonly string[], retrieved: readonly string[], k: number): number {
  const expectedSet = normalizedSet(expected);
  if (expectedSet.size === 0) return 0;
  const hits = new Set(
    retrieved
      .slice(0, k)
      .map(normalizeEvidenceId)
      .filter((path) => expectedSet.has(path)),
  );
  return hits.size / expectedSet.size;
}

function overlapCount(left: readonly string[], right: readonly string[], k: number): number {
  const rightSet = normalizedSet(right.slice(0, k));
  return left.slice(0, k).filter((path) => rightSet.has(normalizeEvidenceId(path))).length;
}

function normalizedSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizeEvidenceId));
}

function typeForPage(page: VaultPage): RetrievalGoldType {
  if (page.type === "threads") return "temporal";
  if (page.type === "decisions" || page.type === "lessons") return "causal";
  if (page.type === "tools" || page.type === "projects") return "dependency";
  if (page.type === "references") return "provenance";
  return "fact";
}

function firstCodeOrApiToken(body: string): string | null {
  if (/```/.test(body)) {
    const match = body.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*\(/u);
    if (match) return match[0].replace(/\s*\($/u, "()");
    return "code block";
  }
  const api = body.match(/\b(?:api|sdk|mcp|http|graphql|sqlite|vector|embedding|search|server|client)\b/iu);
  return api?.[0] ?? null;
}

function isMetadataPathHeavy(page: VaultPage): boolean {
  return /\d{4}-\d{2}-\d{2}|\d{4}/u.test(page.relPath)
    || page.relPath.split("/").length >= 3
    || Boolean(page.updated);
}

function looksGraphOrHydeFavoring(page: VaultPage): boolean {
  return /\[\[[^\]]+\]\]|derived[_ -]?from|supersed|related|relations?:|depends on|blocked by/iu.test(page.body);
}

function extractHeadings(body: string): string[] {
  return (body.match(/^#{1,3}\s+(.+)$/gmu) ?? [])
    .map((heading) => heading.replace(/^#{1,3}\s+/u, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function titleFromPath(relPath: string, _vaultRoot?: string): string {
  return basename(relPath).replace(/\.md$/iu, "").replace(/[-_]+/gu, " ");
}

function typeFromPath(relPath: string): string {
  const parts = relPath.split("/");
  return parts[1] ?? "references";
}

function shortTitle(title: string): string {
  const words = title.split(/\s+/u).filter(Boolean);
  if (words.length <= 4) return title;
  return words.slice(0, 4).join(" ");
}

function pathWords(relPath: string): string {
  return relPath
    .replace(/\.md$/iu, "")
    .split("/")
    .slice(1)
    .join(" ")
    .replace(/[-_]+/gu, " ");
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function readGoldType(value: unknown): RetrievalGoldType {
  return value === "causal" || value === "temporal" || value === "dependency" || value === "provenance"
    ? value
    : "fact";
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function normalizeQuery(query: string): string {
  return query.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function isRecallScaffoldExcludedPath(relPath: string): boolean {
  const normalized = normalizePath(relPath);
  return isWikiDotDirectoryPath(normalized)
    || /^raw\/\.[^/]+(?:\/|$)/u.test(normalized)
    || normalized === "wiki/archive"
    || normalized.startsWith("wiki/archive/");
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ").trim();
}

function redactLocalPath(path: string): string {
  const home = process.env["USERPROFILE"] ?? process.env["HOME"];
  if (home && path.toLowerCase().startsWith(home.toLowerCase())) {
    return `<user-home>${path.slice(home.length)}`;
  }
  return path.replace(/^[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/]+/iu, "<user-home>");
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : round(count / total);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000;
}
