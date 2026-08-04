import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import { redactSecrets } from "../privacy/redaction.js";
import { readRelations, writeRelations, type RelationMap } from "../retrieval/relations.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { hasArchiveOrSystemPathComponent } from "../storage/archive-paths.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";
import { kebabCase } from "../storage/slug.js";
import type { ConsolidationFact } from "./filter-noise.js";
import { assessClaimSupport } from "./faithfulness.js";
import { hashCompileOperationForLedger, isProposalResolved } from "./proposal-ledger.js";

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
  llmCalls: number;
  proposedPath?: string;
  /** True when stageNarrativeReview skipped restaging a ledger-resolved op. */
  proposalAlreadyResolved?: boolean;
  reason?: string;
  tokensUsed?: LLMTokenUsage;
}

export interface StageNarrativeReviewResult {
  path: string;
  alreadyResolved: boolean;
}

/**
 * Proposal-only frontmatter field: fingerprints no-body safety-gate reviews so
 * distinct claim/fact sets do not share a ledger key. Stripped on apply so it
 * never lands on the wiki page.
 */
export const NARRATIVE_REVIEW_KEY_FIELD = "narrative_review_key";

export interface SynthesizeNarrativeOptions {
  vaultRoot: string;
  pageRelPath: string;
  facts: ConsolidationFact[];
  llm: LLMProvider;
  now: Date;
  faithfulnessCheck?: boolean;
  /** Advanced local escape hatch; callers should surface its warning. */
  logger?: (message: string) => void;
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
  const sourceHash = sha256(current);
  const faithfulnessCheck = opts.faithfulnessCheck !== false;
  if (!faithfulnessCheck) {
    (opts.logger ?? console.warn)(
      `memory compile: unverified generation enabled for ${opts.pageRelPath}; this advanced local opt-out can write without a faithfulness verdict`,
    );
  }
  let detectResponse: Awaited<ReturnType<LLMProvider["chat"]>>;
  try {
    detectResponse = await opts.llm.chat({
      messages: [
        { role: "system", content: NARRATIVE_DETECT_SYSTEM_PROMPT },
        { role: "user", content: buildDetectPrompt(opts.pageRelPath, parsed.frontmatter, parsed.body, opts.facts) },
      ],
      temperature: 0,
      jsonSchema: { name: "NarrativeDetectOutput", schema: DETECT_SCHEMA, strict: true },
    });
  } catch (error) {
    return stageUnverifiableSynthesis(opts, `narrative synthesis detect failed: ${errorMessage(error)}`, 1);
  }
  let llmCalls = 1;
  let tokensUsed = detectResponse.tokensUsed;
  let detect: NarrativeDetectOutput;
  try {
    throwIfUnverifiableResponse("narrative synthesis detect", detectResponse.finishReason);
    detect = parseDetectOutput(detectResponse.content);
  } catch (error) {
    return stageUnverifiableSynthesis(opts, `narrative synthesis detect unverifiable: ${errorMessage(error)}`, llmCalls, tokensUsed);
  }

  if (detect.contradicted_claims.length === 0 && detect.net_new_facts.length === 0) {
    const baseFrontmatter = { ...parsed.frontmatter, updated: isoDate(opts.now) };
    const relationFrontmatter = await applyFactRelationsToFrontmatter(
      opts.vaultRoot,
      opts.pageRelPath,
      baseFrontmatter,
      opts.facts,
    );
    if (relationFrontmatter !== baseFrontmatter) {
      // Relation-only updates still derive from the snapshot the detector saw.
      // Do not let a stale frontmatter write replace a concurrent body edit.
      const beforeRelationWrite = await readFile(fullPath, "utf-8");
      if (sha256(beforeRelationWrite) !== sourceHash) {
        return stageUnverifiableSynthesis(opts, "source page changed while narrative generation was in progress", llmCalls, tokensUsed);
      }
      await atomicWrite(fullPath, serializeFrontmatter(relationFrontmatter, parsed.body));
      return { outcome: "rewritten", path: opts.pageRelPath, proposed: false, llmCalls, tokensUsed };
    }
    return { outcome: "unchanged", path: opts.pageRelPath, proposed: false, llmCalls, tokensUsed };
  }
  if (detect.contradicted_claims.length >= 10) {
    const staged = await stageNarrativeReview(opts.vaultRoot, opts.pageRelPath, {
      reason: "too many contradicted claims for automatic rewrite",
      contradicted_claims: detect.contradicted_claims,
      net_new_facts: detect.net_new_facts,
      facts: opts.facts,
    }, opts.now);
    return stagedReviewResult(opts.pageRelPath, staged, {
      reason: "too many contradicted claims for automatic rewrite",
      llmCalls,
      tokensUsed,
    });
  }

  let synthResponse: Awaited<ReturnType<LLMProvider["chat"]>>;
  try {
    synthResponse = await opts.llm.chat({
      messages: [
        { role: "system", content: NARRATIVE_SYNTHESIS_SYSTEM_PROMPT },
        { role: "user", content: buildSynthesisPrompt(opts.pageRelPath, parsed.frontmatter, parsed.body, opts.facts, detect) },
      ],
      temperature: 0.2,
      jsonSchema: { name: "NarrativeSynthesisOutput", schema: SYNTHESIS_SCHEMA, strict: true },
    });
  } catch (error) {
    return stageUnverifiableSynthesis(opts, `narrative synthesis failed: ${errorMessage(error)}`, llmCalls + 1, tokensUsed);
  }
  llmCalls += 1;
  tokensUsed = addTokenUsage(tokensUsed, synthResponse.tokensUsed);
  let synth: NarrativeSynthesisOutput;
  try {
    throwIfUnverifiableResponse("narrative synthesis", synthResponse.finishReason);
    synth = parseSynthesisOutput(synthResponse.content);
  } catch (error) {
    return stageUnverifiableSynthesis(opts, `narrative synthesis unverifiable: ${errorMessage(error)}`, llmCalls, tokensUsed);
  }

  // Deterministic conservation checks are the first gate. The judge only adds
  // a semantic check after syntax, dated history, and evidence anchors survive.
  const body = normalizeBody(synth.body);
  const placeholder = findUnfilledPlaceholder(body);
  if (placeholder) {
    // Stage WITHOUT the generated body: a placeholder body is template output,
    // and staging it would put garbage in front of the reviewer.
    return stageUnverifiableSynthesis(
      opts,
      `synthesized body contains unfilled template placeholder: ${placeholder}`,
      llmCalls,
      tokensUsed,
    );
  }
  const validation = validateNarrativeBody(body);
  const wikilinkCheck = validateWikilinkRetention(parsed.body, body);
  const datedCheck = validateDatedBlockConservation(parsed.body, body, detect.contradicted_claims);
  if (!validation.ok || !wikilinkCheck.ok || !datedCheck.ok) {
    const reason = !validation.ok ? validation.reason : !wikilinkCheck.ok ? wikilinkCheck.reason : !datedCheck.ok ? datedCheck.reason : "deterministic conservation check failed";
    return stageUnverifiableSynthesis(opts, reason, llmCalls, tokensUsed, body);
  }

  if (faithfulnessCheck) {
    const verdict = await assessClaimSupport({
      body: synth.body,
      facts: opts.facts.map((fact) => ({ fact_id: fact.fact_id, narrative: fact.fact.narrative })),
      llm: opts.llm,
      priorBody: parsed.body,
    });
    llmCalls += verdict.llmCalls;
    if (verdict.outcome !== "supported") {
      const reason = verdict.outcome === "unsupported"
        ? `unsupported claims: ${verdict.unsupportedClaims.join("; ")}`
        : `faithfulness check unverifiable: ${verdict.reason ?? "unknown judge failure"}`;
      return stageUnverifiableSynthesis(opts, reason, llmCalls, tokensUsed, body);
    }
  }
  if (narrativeEquivalent(parsed.body, body)) {
    return { outcome: "unchanged", path: opts.pageRelPath, proposed: false, llmCalls, tokensUsed };
  }

  // Never overwrite a page that changed after the LLM saw it. This is a
  // deterministic source-hash conservation gate, not a best-effort warning.
  const beforeWrite = await readFile(fullPath, "utf-8");
  if (sha256(beforeWrite) !== sourceHash) {
    return stageUnverifiableSynthesis(opts, "source page changed while narrative generation was in progress", llmCalls, tokensUsed, body);
  }
  const history = await archivePageVersion(opts.vaultRoot, opts.pageRelPath, current, opts.now, parsed.frontmatter);
  const nextFrontmatter = await applyFactRelationsToFrontmatter(
    opts.vaultRoot,
    opts.pageRelPath,
    nextNarrativeFrontmatter(parsed.frontmatter, opts.now, opts.facts, history),
    opts.facts,
  );
  await atomicWrite(fullPath, serializeFrontmatter(nextFrontmatter, `${body}\n`));
  return { outcome: "rewritten", path: opts.pageRelPath, proposed: false, llmCalls, tokensUsed };
}

export function isNarrativeKnowledgePageType(value: unknown): value is NarrativeKnowledgeType {
  return typeof value === "string" && NARRATIVE_KNOWLEDGE_TYPES.includes(value as NarrativeKnowledgeType);
}

export function isNarrativeKnowledgePagePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  const match = /^wiki\/([^/.][^/]*)\/[^/]+\.md$/u.exec(normalized);
  return Boolean(match?.[1] && isNarrativeKnowledgePageType(match[1]));
}

/**
 * Unfilled template placeholders like "[specific areas of enhancement and
 * testing]" or "[TBD]": bracketed lowercase multi-word phrases (or TBD/TODO
 * markers) that are not wikilinks or markdown links. They are LLM template
 * output, never grounded content.
 */
const UNFILLED_PLACEHOLDER_RE = /(?<!\[)\[(?:TBD|TODO[^\]\n]*|\.\.\.|[a-z][a-z0-9'-]*(?: [a-z0-9'-]+){2,})\](?!\]|\()/;

export function findUnfilledPlaceholder(text: string): string | null {
  const match = UNFILLED_PLACEHOLDER_RE.exec(text);
  return match ? match[0] : null;
}

const PROPOSAL_REASON_MAX_CHARS = 300;

/**
 * Proposal Reason lines are review UI text, not evidence storage. Faithfulness
 * verdicts can echo whole raw captures (secrets, hostnames, file maps) into the
 * reason, so redact and hard-bound it before it reaches a staged proposal file.
 */
export function sanitizeProposalReason(reason: string): string {
  const flattened = redactSecrets(reason).replace(/\s+/g, " ").trim();
  return flattened.length > PROPOSAL_REASON_MAX_CHARS
    ? `${flattened.slice(0, PROPOSAL_REASON_MAX_CHARS - 3)}...`
    : flattened;
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

/** Build a staged-review result; omit proposedPath when the ledger already resolved it. */
function stagedReviewResult(
  pageRelPath: string,
  staged: StageNarrativeReviewResult,
  opts: { reason: string; llmCalls: number; tokensUsed?: LLMTokenUsage },
): SynthesisResult {
  if (staged.alreadyResolved) {
    return {
      outcome: "staged-for-review",
      path: pageRelPath,
      proposed: false,
      proposalAlreadyResolved: true,
      reason: opts.reason,
      llmCalls: opts.llmCalls,
      tokensUsed: opts.tokensUsed,
    };
  }
  return {
    outcome: "staged-for-review",
    path: pageRelPath,
    proposed: true,
    proposedPath: staged.path,
    proposalAlreadyResolved: false,
    reason: opts.reason,
    llmCalls: opts.llmCalls,
    tokensUsed: opts.tokensUsed,
  };
}

async function stageUnverifiableSynthesis(
  opts: SynthesizeNarrativeOptions,
  reason: string,
  llmCalls: number,
  tokensUsed?: LLMTokenUsage,
  body?: string,
): Promise<SynthesisResult> {
  const staged = await stageNarrativeReview(opts.vaultRoot, opts.pageRelPath, {
    reason,
    ...(body ? { body } : {}),
    facts: opts.facts,
  }, opts.now);
  return stagedReviewResult(opts.pageRelPath, staged, { reason, llmCalls, tokensUsed });
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
): Promise<StageNarrativeReviewResult> {
  const proposedRelPath = `wiki/compile-proposed/${basename(pageRelPath)}`;
  const fullPath = safeResolveUnder(vaultRoot, proposedRelPath);
  if (!fullPath) throw new Error(`invalid proposed path for ${pageRelPath}`);
  const sourceFullPath = safeResolveUnder(vaultRoot, pageRelPath);
  if (!sourceFullPath || !existsSync(sourceFullPath)) throw new Error(`narrative review source missing: ${pageRelPath}`);
  const current = parseFrontmatter(await readFile(sourceFullPath, "utf-8"));
  const record = asRecord(packet);
  const hasExplicitBody = typeof record.body === "string" && record.body.trim().length > 0;
  const proposedBody = hasExplicitBody
    ? normalizeBody(record.body as string)
    : normalizeBody(current.body);
  const reason = typeof record.reason === "string" && record.reason.trim().length > 0
    ? sanitizeProposalReason(record.reason)
    : "narrative synthesis staged for review";
  // Keep the ledger fingerprint and review metadata on the sanitized reason so
  // the proposal file never carries the unbounded raw verdict text.
  record.reason = reason;
  const reviewMetadata: Record<string, unknown> = {
    path: pageRelPath,
    ...record,
  };
  delete reviewMetadata.body;
  // Match readOperation / dashboard promote-reject shape. When the packet has no
  // body (e.g. ≥10 contradicted-claims safety gate), proposedBody is the current
  // page text — fold a review fingerprint into frontmatter so distinct claim/fact
  // sets do not share one ledger key. Apply strips this field before writing.
  const frontmatter: Record<string, unknown> = {};
  if (!hasExplicitBody) {
    frontmatter[NARRATIVE_REVIEW_KEY_FIELD] = hashNarrativeReviewPacket(record);
  }
  const compileOp = {
    kind: "rewrite_page" as const,
    path: pageRelPath,
    body: proposedBody,
    frontmatter,
  };
  // Do not restage a proposal the human already approved/rejected (ledger).
  if (await isProposalResolved(vaultRoot, compileOp)) {
    // Only remove the proposed file when it is this same op — an unrelated
    // pending draft (newer review, basename collision) must stay for humans.
    if (existsSync(fullPath)) await removeProposedDraftIfSameOp(fullPath, compileOp);
    return { path: proposedRelPath, alreadyResolved: true };
  }
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
        stringifyFencedJson(compileOp),
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
  return { path: proposedRelPath, alreadyResolved: false };
}

/**
 * Remove a compile-proposed draft only when its compile-op matches `compileOp`.
 * Leaves unrelated pending drafts (different review / basename collision) intact.
 */
export async function removeProposedDraftIfSameOp(
  fullPath: string,
  compileOp: unknown,
): Promise<boolean> {
  try {
    const text = await readFile(fullPath, "utf-8");
    const block = /```compile-op\s*([\s\S]*?)```/m.exec(text)?.[1];
    if (!block) return false;
    const parsed = JSON.parse(block) as unknown;
    if (hashCompileOperationForLedger(parsed) !== hashCompileOperationForLedger(compileOp)) {
      return false;
    }
    await rm(fullPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Stable fingerprint of review metadata for no-body narrative proposal packets. */
export function hashNarrativeReviewPacket(record: Record<string, unknown>): string {
  const contradicted = Array.isArray(record.contradicted_claims)
    ? record.contradicted_claims.filter((item): item is string => typeof item === "string")
    : [];
  const netNew = Array.isArray(record.net_new_facts)
    ? record.net_new_facts.filter((item): item is string => typeof item === "string")
    : [];
  // Prefer source content/paths over positional f_N ids — filterNoiseForPage
  // reassigns f_0.. per batch, so different raws can share the same ids.
  // Omit run-volatile timestamps (observedAt/compressedAt) so synthetic facts
  // from makeSyntheticCompressedFacts do not re-key every compile pass.
  const payload = {
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
    contradicted_claims: [...contradicted].sort(),
    net_new_facts: [...netNew].sort(),
    source_facts: extractReviewSourceFacts(record.facts),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

function extractReviewSourceFacts(facts: unknown): Array<Record<string, string>> {
  if (!Array.isArray(facts)) return [];
  const rows: Array<Record<string, string>> = [];
  for (const item of facts) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as {
      fact_id?: unknown;
      text?: unknown;
      fact?: {
        narrative?: unknown;
        sourceRawPath?: unknown;
        sessionId?: unknown;
        facts?: unknown;
      };
    };
    const nested = row.fact && typeof row.fact === "object" ? row.fact : undefined;
    const narrative = typeof nested?.narrative === "string"
      ? nested.narrative.trim()
      : typeof row.text === "string"
        ? row.text.trim()
        : "";
    const sourceRawPath = typeof nested?.sourceRawPath === "string" ? nested.sourceRawPath.trim() : "";
    const sessionId = typeof nested?.sessionId === "string" ? nested.sessionId.trim() : "";
    const factLines = Array.isArray(nested?.facts)
      ? nested.facts.filter((line): line is string => typeof line === "string").map((line) => line.trim()).filter(Boolean)
      : [];
    if (!narrative && !sourceRawPath && !sessionId && factLines.length === 0) {
      // Fall back to positional id only when no stable source content exists.
      if (typeof row.fact_id === "string" && row.fact_id.trim().length > 0) {
        rows.push({ fact_id: row.fact_id.trim() });
      }
      continue;
    }
    rows.push({
      ...(narrative ? { narrative } : {}),
      ...(sourceRawPath ? { sourceRawPath } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(factLines.length > 0 ? { facts: factLines.slice().sort().join("\n") } : {}),
    });
  }
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
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
    source_facts: [...new Set([
      ...(Array.isArray(current.source_facts) ? current.source_facts.filter((fact): fact is string => typeof fact === "string") : []),
      ...facts.map((fact) => fact.fact_id),
    ])],
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
      if (hasArchiveOrSystemPathComponent(`wiki/${rel}`)) continue;
      if (entry.isDirectory()) {
        if (rel.split("/").some((part) => part.toLowerCase().endsWith("-proposed"))) continue;
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
  const parsed = parseJsonObject(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("narrative synthesis detect: LLM returned a non-object response");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "contradicted_claims" || keys[1] !== "net_new_facts") {
    throw new Error("narrative synthesis detect: LLM returned an invalid response schema");
  }
  if (!isStringArray(record.contradicted_claims) || !isStringArray(record.net_new_facts)) {
    throw new Error("narrative synthesis detect: LLM returned invalid claim arrays");
  }
  return {
    contradicted_claims: record.contradicted_claims,
    net_new_facts: record.net_new_facts,
  };
}

function parseSynthesisOutput(content: string): NarrativeSynthesisOutput {
  const parsed = parseJsonObject(content) as Partial<NarrativeSynthesisOutput>;
  if (typeof parsed.body !== "string" || parsed.body.trim().length === 0) {
    throw new Error("narrative synthesis: LLM returned no body");
  }
  return { body: parsed.body };
}

function throwIfUnverifiableResponse(stage: string, finishReason: string): void {
  if (finishReason !== "stop") {
    if (finishReason === "length" || finishReason === "filter") {
      throw new Error(`${stage}: LLM response truncated (finishReason=${finishReason})`);
    }
    throw new Error(`${stage}: LLM response unverifiable (finishReason=${finishReason})`);
  }
}

function parseJsonObject(content: string): unknown {
  // Reasoning models may emit <think> traces and multiple fences; try every
  // plausible candidate before giving up instead of trusting the first fence.
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gu, "");
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gmu)) {
    const inner = match[1]?.trim();
    if (inner) candidates.push(inner);
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("narrative synthesis: LLM returned invalid JSON");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateWikilinkRetention(currentBody: string, nextBody: string): { ok: true } | { ok: false; reason: string } {
  const existing = Array.from(currentBody.matchAll(/\[\[[^\]]+\]\]/gu)).map((match) => match[0]!);
  if (existing.length === 0) return { ok: true };
  const missing = existing.filter((link) => !nextBody.includes(link));
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: `synthesized body dropped wikilinks: ${missing.join(", ")}` };
}

export function validateDatedBlockConservation(currentBody: string, nextBody: string, contradictedClaims: string[]): { ok: true } | { ok: false; reason: string } {
  const previous = datedBlocks(currentBody);
  if (previous.size === 0) return { ok: true };
  const contradicted = new Set(contradictedClaims.map(normalizeBody));
  const missing = [...previous.values()]
    .flatMap((content) => content.split(/\n+/))
    .map((line) => line.replace(/^\s*[-*+]\s+/u, "").trim())
    .filter((line) => line.length > 0 && !/\[\[[^\]]+\]\]/u.test(line))
    .filter((line) => !contradicted.has(normalizeBody(line)))
    .filter((line) => !nextBody.includes(line));
  return missing.length === 0
    ? { ok: true }
    : { ok: false, reason: `synthesized body dropped dated evidence spans: ${missing.join("; ")}` };
}

function datedBlocks(body: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let heading: string | undefined;
  let content: string[] = [];
  const flush = () => {
    if (heading) blocks.set(heading, normalizeBody(content.join("\n")));
    heading = undefined;
    content = [];
  };
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      flush();
      if (/^##\s+\S*\d{4}-\d{2}-\d{2}/u.test(line)) heading = line.trim();
      continue;
    }
    if (heading) content.push(line);
  }
  flush();
  return blocks;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
