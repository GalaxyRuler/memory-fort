import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { LLMProvider, LLMTokenUsage } from "../llm/types.js";
import { filterWikiReferencesToExisting, stripProsePathLeaksFromText } from "../llm/proposal-grounding.js";
import { readRelationTarget, type SerializedRelationEdge } from "../retrieval/relations.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";
import { type PageType } from "../storage/paths.js";
import { kebabCase, normalizeWikiPagePath } from "../storage/slug.js";
import { extractEntityFacts } from "./fact-extract.js";
import { filterNoiseForPage } from "./filter-noise.js";
import { blocksToMarkdown, parsePageIR, renderPageIRWithSectionBody } from "./parse-pageir.js";
import { compileSectionPatch, type SectionPatch } from "./patch-compiler.js";
import { planSectionPatches } from "./planner.js";
import { rendererOutputToBlocks, renderSectionPatch } from "./renderer.js";
import { validateRender } from "./validate-patch.js";
import type { CompressedFact } from "../facts/store.js";

export type CompileOperation =
  | {
      kind: "write_page";
      path: string;
      frontmatter?: Record<string, unknown>;
      body: string;
    }
  | {
      kind: "append_page";
      path: string;
      section: string;
    }
  | {
      kind: "rewrite_page";
      path: string;
      frontmatter?: Record<string, unknown>;
      body: string;
    }
  | {
      kind: "section_patch";
      path: string;
      section_id: string;
      patch: SectionPatch[];
    }
  | {
      kind: "update_index";
      path?: string;
      entries: string[];
    }
  | {
      kind: "append_log";
      path?: string;
      line: string;
    };

export type ParseCompileOperationsResult =
  | { ok: true; operations: CompileOperation[] }
  | { ok: false; reason: string };

export interface ApplyCompileOperationsOptions {
  vaultRoot: string;
  operations: CompileOperation[];
  plan?: boolean;
  now?: Date;
  rewriteLLM?: LLMProvider;
  rewriteMaxBytes?: number;
  extractFacts?: boolean;
}

export interface ApplyCompileOperationsResult {
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
  extractionTokensUsed?: LLMTokenUsage;
  rewriteTokensUsed?: LLMTokenUsage;
}

export type CompileOperationOutcomeKind =
  | "created"
  | "appended"
  | "rewritten"
  | "index-updated"
  | "log-appended"
  | "staged-for-review"
  | "merged"
  | "skipped: no new content"
  | "rejected";

export type CompileOperationConversion = "write->append: target already existed";

export interface CompileOperationOutcome {
  path: string;
  outcome: CompileOperationOutcomeKind;
  reason?: string;
  converted?: CompileOperationConversion;
  contentPreserved: boolean;
}

const COMPILE_OPS_RE = /```compile-ops\s*([\s\S]*?)```/m;
const COMPILE_OP_RE = /```compile-op\s*([\s\S]*?)```/m;
const DEFAULT_REWRITE_MAX_BYTES = 80_000;
const PAGE_TYPES_BY_CATEGORY = {
  projects: "projects",
  people: "people",
  decisions: "decisions",
  lessons: "lessons",
  references: "references",
  tools: "tools",
  threads: "threads",
  procedures: "procedures",
  prospective: "prospective",
} as const satisfies Record<PageType, PageType>;

export function isKnowledgePageType(type: PageType): boolean {
  return type === "projects" ||
    type === "lessons" ||
    type === "decisions" ||
    type === "references" ||
    type === "tools" ||
    type === "people" ||
    type === "prospective";
}

export function parseCompileOperationsBlock(text: string): ParseCompileOperationsResult {
  const block = COMPILE_OPS_RE.exec(text)?.[1];
  if (!block) return { ok: false, reason: "missing fenced compile-ops block" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      reason: `compile-ops JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const candidates = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { operations?: unknown }).operations)
      ? (parsed as { operations: unknown[] }).operations
      : null;
  if (!candidates) return { ok: false, reason: "compile-ops must be an array or { operations: [...] }" };

  const operations: CompileOperation[] = [];
  for (const candidate of candidates) {
    const operation = readOperation(candidate);
    if (!operation) return { ok: false, reason: "compile-ops contains an unsupported operation" };
    operations.push(operation);
  }
  return { ok: true, operations };
}

export function parseCompileOperationBlock(text: string): { ok: true; operation: CompileOperation } | { ok: false; reason: string } {
  const block = COMPILE_OP_RE.exec(text)?.[1];
  if (!block) return { ok: false, reason: "missing fenced compile-op block" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return {
      ok: false,
      reason: `compile-op JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const operation = readOperation(parsed);
  if (!operation) return { ok: false, reason: "compile-op contains an unsupported operation" };
  return { ok: true, operation };
}

export async function applyCompileOperations(
  opts: ApplyCompileOperationsOptions,
): Promise<ApplyCompileOperationsResult> {
  const result: ApplyCompileOperationsResult = {
    applied: [],
    proposed: [],
    planned: [],
    rejected: [],
    outcomes: [],
    referencesStripped: 0,
    prosePathLeaks: 0,
    pagesRewritten: 0,
    pagesUpdated: 0,
    pagesUnchanged: 0,
    factsExtracted: 0,
    sessionsScanned: 0,
  };
  const now = opts.now ?? new Date();
  const prepared = prepareCompileOperations(opts.vaultRoot, opts.operations, now);
  result.rejected.push(...prepared.rejected);
  result.outcomes.push(...prepared.outcomes);

  for (const preparedOperation of prepared.operations) {
    const relPath = compileOperationPath(preparedOperation.operation);
    if (!isAllowedCompileRelPath(relPath)) {
      result.rejected.push({ path: relPath, reason: "path outside allowed vault targets" });
      result.outcomes.push({
        path: relPath,
        outcome: "rejected",
        reason: "path outside allowed vault targets",
        contentPreserved: false,
      });
      continue;
    }
    const grounded = await groundOperation(opts.vaultRoot, preparedOperation.operation, now);
    result.referencesStripped += grounded.referencesStripped;
    result.prosePathLeaks += grounded.prosePathLeaks;

    if (opts.plan) {
      result.planned.push(relPath);
      continue;
    }

    const deterministicRewrite = await rewriteExistingKnowledgePageUpdate({
      vaultRoot: opts.vaultRoot,
      operation: grounded.operation,
      now,
      llm: opts.rewriteLLM,
      maxBytes: opts.rewriteMaxBytes ?? DEFAULT_REWRITE_MAX_BYTES,
      extractFacts: opts.extractFacts ?? false,
    });
    if (deterministicRewrite.handled) {
      result.referencesStripped += deterministicRewrite.referencesStripped;
      result.prosePathLeaks += deterministicRewrite.prosePathLeaks;
      if (deterministicRewrite.outcome === "rewritten") {
        result.applied.push(relPath);
        result.pagesRewritten += 1;
        result.pagesUpdated += 1;
      } else if (deterministicRewrite.outcome === "staged-for-review") {
        result.proposed.push(deterministicRewrite.proposedPath);
      } else if (deterministicRewrite.outcome === "skipped: no new content") {
        result.applied.push(relPath);
        result.pagesUnchanged += 1;
      }
      if (deterministicRewrite.tokensUsed) {
        result.rewriteTokensUsed = addTokenUsage(result.rewriteTokensUsed, deterministicRewrite.tokensUsed);
      }
      result.factsExtracted += deterministicRewrite.factsExtracted ?? 0;
      result.sessionsScanned += deterministicRewrite.sessionsScanned ?? 0;
      if (deterministicRewrite.extractionTokensUsed) {
        result.extractionTokensUsed = addTokenUsage(result.extractionTokensUsed, deterministicRewrite.extractionTokensUsed);
      }
      result.outcomes.push({
        path: relPath,
        outcome: deterministicRewrite.outcome,
        ...(deterministicRewrite.reason ? { reason: deterministicRewrite.reason } : {}),
        contentPreserved: true,
      });
      continue;
    }

    const steering = await steerExistingPageOperation(opts.vaultRoot, grounded.operation, now);
    if (steering.stage) {
      const proposedPath = await stageCompileProposal(opts.vaultRoot, grounded.operation, now, steering.reason);
      result.proposed.push(proposedPath);
      result.outcomes.push({
        path: relPath,
        outcome: "staged-for-review",
        reason: steering.reason,
        contentPreserved: true,
      });
      continue;
    }
    if (steering.skipped) {
      if (!steering.converted) result.applied.push(relPath);
      result.outcomes.push({
        path: relPath,
        outcome: "skipped: no new content",
        ...(steering.converted ? { reason: "no new content" } : {}),
        ...(steering.converted ? { converted: steering.converted } : {}),
        contentPreserved: true,
      });
      continue;
    }

    const conversion = await convertExistingWriteToAppend(opts.vaultRoot, grounded.operation, now);
    if (conversion.skipped) {
      result.outcomes.push({
        path: relPath,
        outcome: "skipped: no new content",
        reason: "no new content",
        converted: conversion.converted,
        contentPreserved: true,
      });
      continue;
    }
    const operationToApply = conversion.operation;
    const converted = conversion.converted;

    const rewriteGuard = operationToApply.kind === "rewrite_page"
      ? await guardRewriteOperation(opts.vaultRoot, operationToApply, now)
      : { ok: true as const, stage: false as const };
    if (!rewriteGuard.ok) {
      result.rejected.push({ path: relPath, reason: rewriteGuard.reason });
      result.outcomes.push({
        path: relPath,
        outcome: "rejected",
        reason: rewriteGuard.reason,
        contentPreserved: false,
      });
      continue;
    }
    if (rewriteGuard.stage) {
      const reason = rewriteGuard.reason;
      const proposedPath = await stageCompileProposal(opts.vaultRoot, operationToApply, now, reason);
      result.proposed.push(proposedPath);
      result.outcomes.push({
        path: relPath,
        outcome: "staged-for-review",
        reason,
        contentPreserved: true,
      });
      continue;
    }

    // Converted writes are deduped before this point, but still respect the
    // existing confidence gate: thin updates stage for review instead of
    // becoming canonical from a single raw source.
    if (!hasHighConfidence(grounded.operation)) {
      const reason = preparedOperation.stageReason ?? "low confidence";
      const proposedPath = await stageCompileProposal(opts.vaultRoot, operationToApply, now, reason);
      result.proposed.push(proposedPath);
      result.outcomes.push({
        path: relPath,
        outcome: "staged-for-review",
        reason,
        ...(converted ? { converted } : {}),
        contentPreserved: true,
      });
      continue;
    }

    const applied = await applyOperation(opts.vaultRoot, operationToApply, now);
    if (applied.ok) {
      result.applied.push(relPath);
      if (applied.outcome === "rewritten") {
        result.pagesRewritten += 1;
        result.pagesUpdated += 1;
      } else if (applied.outcome === "skipped: no new content") {
        result.pagesUnchanged += 1;
      }
      const appliedConversion = converted ?? applied.converted;
      result.outcomes.push({
        path: relPath,
        outcome: applied.outcome,
        ...(appliedConversion ? { converted: appliedConversion } : {}),
        contentPreserved: true,
      });
    } else {
      result.rejected.push({ path: relPath, reason: applied.reason });
      result.outcomes.push({
        path: relPath,
        outcome: "rejected",
        reason: applied.reason,
        contentPreserved: false,
      });
    }
  }

  return result;
}

interface PreparedCompileOperation {
  operation: CompileOperation;
  stageReason?: string;
}

function prepareCompileOperations(
  vaultRoot: string,
  operations: CompileOperation[],
  now: Date,
): {
  operations: PreparedCompileOperation[];
  rejected: Array<{ path: string; reason: string }>;
  outcomes: CompileOperationOutcome[];
} {
  const prepared: PreparedCompileOperation[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const outcomes: CompileOperationOutcome[] = [];
  const pageByPath = new Map<string, PreparedCompileOperation>();
  const date = now.toISOString().slice(0, 10);

  for (const operation of operations) {
    const originalPath = compileOperationPath(operation);
    if (!isAllowedCompileRelPath(originalPath)) {
      prepared.push({ operation });
      continue;
    }

    if (operation.kind !== "write_page" && operation.kind !== "append_page" && operation.kind !== "rewrite_page" && operation.kind !== "section_patch") {
      prepared.push({ operation });
      continue;
    }

    const target = readWikiPageTarget(originalPath);
    if (target.kind === "invalid") {
      rejected.push({ path: originalPath, reason: target.reason });
      outcomes.push({
        path: originalPath,
        outcome: "rejected",
        reason: target.reason,
        contentPreserved: false,
      });
      continue;
    }
    if (target.kind === "non-page") {
      prepared.push({ operation });
      continue;
    }

    const normalizedPath = target.path;
    const fullPath = join(vaultRoot, ...normalizedPath.split("/"));
    const existing = pageByPath.get(normalizedPath);
    if (existing) {
      if (
        existing.operation.kind === "write_page" &&
        existing.stageReason === "append->create: low confidence" &&
        operation.kind === "write_page"
      ) {
        const incomingWrite = withPageOperationTarget(operation, normalizedPath, target.type);
        if (incomingWrite.kind === "write_page") {
          existing.operation = {
            ...incomingWrite,
            body: mergeBody(incomingWrite.body, existing.operation.body),
          };
          delete existing.stageReason;
          outcomes.push({
            path: normalizedPath,
            outcome: "merged",
            reason: "merged append_page into write_page",
            contentPreserved: true,
          });
          continue;
        }
      }
      const merged = mergePageOperations(existing.operation, operation, normalizedPath);
      existing.operation = merged.operation;
      if (merged.stageReason) existing.stageReason = merged.stageReason;
      outcomes.push({
        path: normalizedPath,
        outcome: "merged",
        reason: merged.reason,
        contentPreserved: merged.contentPreserved,
      });
      continue;
    }

    const normalizedOperation = withPageOperationTarget(operation, normalizedPath, target.type);
    const next = operation.kind === "append_page" && !existsSync(fullPath)
      ? {
          operation: {
            kind: "write_page" as const,
            path: normalizedPath,
            frontmatter: {
              type: target.type,
              title: basename(originalPath, ".md"),
              created: date,
              updated: date,
              status: "active",
              lifecycle: "proposed",
              source: "compile-execute",
              confidence: 0.6,
              cognitive_type: "semantic",
            },
            body: operation.section,
          },
          stageReason: "append->create: low confidence",
        }
      : { operation: normalizedOperation };
    prepared.push(next);
    pageByPath.set(normalizedPath, next);
  }

  return { operations: prepared, rejected, outcomes };
}

function readWikiPageTarget(relPath: string):
  | { kind: "page"; path: string; category: PageType; type: PageType }
  | { kind: "invalid"; reason: string }
  | { kind: "non-page" } {
  const normalized = relPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts[0] !== "wiki") return { kind: "non-page" };
  if (parts.length < 3) return { kind: "non-page" };

  const category = parts[1] ?? "";
  if (!isKnownPageCategory(category)) {
    return { kind: "invalid", reason: `unknown wiki page category: ${category}` };
  }
  if (parts.length !== 3 || !parts[2]?.endsWith(".md")) {
    return { kind: "invalid", reason: "malformed wiki page path" };
  }

  return {
    kind: "page",
    path: normalizeWikiPagePath(normalized),
    category,
    type: PAGE_TYPES_BY_CATEGORY[category],
  };
}

function isKnownPageCategory(value: string): value is PageType {
  return Object.prototype.hasOwnProperty.call(PAGE_TYPES_BY_CATEGORY, value);
}

function withPageOperationTarget(operation: CompileOperation, path: string, type: PageType): CompileOperation {
  switch (operation.kind) {
    case "write_page":
      return { ...operation, path, frontmatter: { ...operation.frontmatter, type } };
    case "append_page":
      return { ...operation, path };
    case "rewrite_page":
      return { ...operation, path, frontmatter: { ...operation.frontmatter, type } };
    case "section_patch":
      return { ...operation, path };
    case "update_index":
    case "append_log":
      return operation;
  }
}

function mergePageOperations(
  existing: CompileOperation,
  incoming: CompileOperation,
  path: string,
): { operation: CompileOperation; reason: string; contentPreserved: boolean; stageReason?: string } {
  if (existing.kind === "write_page" && incoming.kind === "append_page") {
    return {
      operation: { ...existing, body: mergeBody(existing.body, incoming.section) },
      reason: "merged append_page into write_page",
      contentPreserved: true,
    };
  }
  if (incoming.kind === "rewrite_page") {
    return {
      operation: incoming,
      reason: `rewrite_page superseded duplicate ${existing.kind} for same target`,
      contentPreserved: true,
    };
  }
  if (existing.kind === "rewrite_page") {
    return {
      operation: existing,
      reason: `skipped duplicate ${incoming.kind} for rewrite target`,
      contentPreserved: false,
    };
  }
  if (existing.kind === "append_page" && incoming.kind === "append_page") {
    return {
      operation: { ...existing, section: mergeBody(existing.section, incoming.section) },
      reason: "merged append_page into append_page",
      contentPreserved: true,
    };
  }
  if (existing.kind === "write_page" && incoming.kind === "write_page") {
    return {
      operation: existing,
      reason: "skipped duplicate write_page for same target",
      contentPreserved: false,
    };
  }
  if (existing.kind === "append_page" && incoming.kind === "write_page") {
    return {
      operation: existing,
      reason: "skipped write_page for existing append target",
      contentPreserved: false,
    };
  }
  return {
    operation: existing,
    reason: `skipped duplicate ${incoming.kind} for same target`,
    contentPreserved: false,
  };
}

function mergeBody(left: string, right: string): string {
  const first = left.trimEnd();
  const second = right.trim();
  if (!first) return `${second}\n`;
  if (!second) return `${first}\n`;
  return `${first}\n\n${second}\n`;
}

async function groundOperation(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date,
): Promise<{ operation: CompileOperation; referencesStripped: number; prosePathLeaks: number }> {
  if (operation.kind !== "write_page" && operation.kind !== "rewrite_page") {
    return { operation, referencesStripped: 0, prosePathLeaks: 0 };
  }

  const frontmatter = normalizeFrontmatter(operation.frontmatter ?? {}, operation.path, now);
  const operationHadRelations = Object.prototype.hasOwnProperty.call(operation.frontmatter ?? {}, "relations");
  const relations = frontmatter.relations && typeof frontmatter.relations === "object"
    ? frontmatter.relations as Record<string, unknown>
    : {};
  let referencesStripped = 0;
  const nextRelations: Record<string, SerializedRelationEdge[]> = {};
  for (const [key, value] of Object.entries(relations)) {
    const values = Array.isArray(value) ? value : [];
    const kept: SerializedRelationEdge[] = [];
    for (const item of values) {
      const target = readRelationTarget(item);
      if (!target) continue;
      const filtered = await filterWikiReferencesToExisting(vaultRoot, [target]);
      referencesStripped += filtered.stripped.length;
      if (filtered.filtered.length > 0) {
        kept.push(item as SerializedRelationEdge);
      }
    }
    if (kept.length > 0) nextRelations[key] = kept;
  }

  const cleanedBody = stripProsePathLeaksFromText(redactSecrets(operation.body));
  return {
    operation: {
      ...operation,
      frontmatter: {
        ...frontmatter,
        ...(operationHadRelations ? { relations: Object.keys(nextRelations).length > 0 ? nextRelations : undefined } : {}),
      },
      body: cleanedBody.text,
    },
    referencesStripped,
    prosePathLeaks: cleanedBody.stripped.length,
  };
}

export async function applyOperation(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date = new Date(),
): Promise<{
  ok: true;
  outcome: Extract<CompileOperationOutcomeKind, "created" | "appended" | "rewritten" | "index-updated" | "log-appended" | "skipped: no new content">;
  converted?: CompileOperationConversion;
} | { ok: false; reason: string }> {
  const relPath = compileOperationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  switch (operation.kind) {
    case "write_page": {
      if (existsSync(fullPath)) {
        if (isExistingKnowledgePagePath(relPath)) {
          return { ok: false, reason: "knowledge-page update requires section_patch" };
        }
        const section = await dedupeExistingWriteBody(fullPath, operation.body, now);
        if (!section) {
          return { ok: true, outcome: "skipped: no new content", converted: "write->append: target already existed" };
        }
        await appendSectionToPage(fullPath, section);
        return { ok: true, outcome: "appended", converted: "write->append: target already existed" };
      }
      await atomicWrite(fullPath, serializeFrontmatter(operation.frontmatter as Frontmatter, `${operation.body.trim()}\n`));
      return { ok: true, outcome: "created" };
    }
    case "append_page": {
      if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
      if (isExistingKnowledgePagePath(relPath)) {
        return { ok: false, reason: "knowledge-page update requires section_patch" };
      }
      if (!await appendSectionHasNewContent(fullPath, operation.section)) {
        return { ok: true, outcome: "skipped: no new content" };
      }
      await appendSectionToPage(fullPath, operation.section);
      return { ok: true, outcome: "appended" };
    }
    case "rewrite_page": {
      if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
      const current = await readFile(fullPath, "utf-8");
      const parsed = parseFrontmatter(current);
      if (normalizeContent(parsed.body) === normalizeContent(operation.body)) {
        return { ok: true, outcome: "skipped: no new content" };
      }
      const archivedPath = await archivePageVersion(vaultRoot, relPath, current, now);
      const previousVersion = typeof parsed.frontmatter.version === "number" && Number.isFinite(parsed.frontmatter.version)
        ? Math.max(1, Math.floor(parsed.frontmatter.version))
        : 1;
      const existingSupersedes = Array.isArray(parsed.frontmatter.supersedes) ? parsed.frontmatter.supersedes : [];
      const frontmatter = normalizeFrontmatter(
        {
          ...parsed.frontmatter,
          ...operation.frontmatter,
          version: previousVersion + 1,
          supersedes: [
            ...existingSupersedes,
            {
              path: archivedPath,
              hash: sha256(current),
              version: previousVersion,
            },
          ],
        },
        operation.path,
        now,
      );
      await atomicWrite(fullPath, serializeFrontmatter(frontmatter, `${operation.body.trim()}\n`));
      return { ok: true, outcome: "rewritten" };
    }
    case "section_patch": {
      if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
      const current = await readFile(fullPath, "utf-8");
      const parsed = parseFrontmatter(current);
      const ir = parsePageIR(current, relPath);
      const section = ir.sections.find((candidate) => candidate.section_id === operation.section_id);
      if (!section) return { ok: false, reason: "section_patch target section not found" };
      const testOp = operation.patch.find((patch) => patch.op === "test");
      if (!testOp || testOp.path !== `/sections/${operation.section_id}/body_hash`) {
        return { ok: false, reason: "section_patch missing body_hash test" };
      }
      if (testOp.value !== section.body_hash) {
        return { ok: false, reason: "section_patch body_hash mismatch" };
      }
      const replaceOp = operation.patch.find((patch) => patch.op === "replace");
      if (!replaceOp || replaceOp.path !== `/sections/${operation.section_id}/body_blocks`) {
        return { ok: false, reason: "section_patch missing body_blocks replace" };
      }
      const replacementBody = blocksToMarkdown(replaceOp.value);
      if (normalizeContent(section.body_markdown) === normalizeContent(replacementBody)) {
        return { ok: true, outcome: "skipped: no new content" };
      }
      const nextBody = renderPageIRWithSectionBody(current, operation.section_id, replaceOp.value);
      if (nextBody === null) return { ok: false, reason: "section_patch target section not found" };
      const archivedPath = await archivePageVersion(vaultRoot, relPath, current, now);
      const previousVersion = typeof parsed.frontmatter.version === "number" && Number.isFinite(parsed.frontmatter.version)
        ? Math.max(1, Math.floor(parsed.frontmatter.version))
        : 1;
      const existingSupersedes = Array.isArray(parsed.frontmatter.supersedes) ? parsed.frontmatter.supersedes : [];
      const frontmatter = normalizeFrontmatter(
        {
          ...parsed.frontmatter,
          version: previousVersion + 1,
          supersedes: [
            ...existingSupersedes,
            {
              path: archivedPath,
              hash: sha256(current),
              version: previousVersion,
            },
          ],
        },
        operation.path,
        now,
      );
      await atomicWrite(fullPath, serializeFrontmatter(frontmatter, nextBody));
      return { ok: true, outcome: "rewritten" };
    }
    case "update_index":
      void fullPath;
      return { ok: true, outcome: "index-updated" };
    case "append_log":
      await appendText(fullPath, `${operation.line.trim()}\n`);
      return { ok: true, outcome: "log-appended" };
  }
}

function isExistingKnowledgePagePath(relPath: string): boolean {
  const target = readWikiPageTarget(relPath);
  return target.kind === "page" && isKnowledgePageType(target.type);
}

async function convertExistingWriteToAppend(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date,
): Promise<
  | { operation: CompileOperation; converted?: CompileOperationConversion; skipped?: false }
  | { skipped: true; converted: CompileOperationConversion }
> {
  if (operation.kind !== "write_page") return { operation };
  const relPath = compileOperationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  if (!existsSync(fullPath)) return { operation };
  const section = await dedupeExistingWriteBody(fullPath, operation.body, now);
  if (!section) {
    return { skipped: true, converted: "write->append: target already existed" };
  }
  return {
    operation: {
      kind: "append_page",
      path: relPath,
      section,
    },
    converted: "write->append: target already existed",
  };
}

async function appendSectionToPage(fullPath: string, section: string): Promise<void> {
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  await atomicWrite(fullPath, serializeFrontmatter(parsed.frontmatter, `${parsed.body.trimEnd()}\n\n${section.trim()}\n`));
}

async function appendSectionHasNewContent(fullPath: string, section: string): Promise<boolean> {
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  return netNewProse(parsed.body, section).length > 0;
}

async function rewriteExistingKnowledgePageUpdate(opts: {
  vaultRoot: string;
  operation: CompileOperation;
  now: Date;
  llm?: LLMProvider;
  maxBytes: number;
  extractFacts: boolean;
}): Promise<
  | { handled: false }
  | {
      handled: true;
      outcome: "rewritten" | "skipped: no new content";
      reason?: string;
      tokensUsed?: LLMTokenUsage;
      extractionTokensUsed?: LLMTokenUsage;
      factsExtracted?: number;
      sessionsScanned?: number;
      referencesStripped: number;
      prosePathLeaks: number;
    }
  | {
      handled: true;
      outcome: "staged-for-review";
      reason: string;
      proposedPath: string;
      tokensUsed?: LLMTokenUsage;
      extractionTokensUsed?: LLMTokenUsage;
      factsExtracted?: number;
      sessionsScanned?: number;
      referencesStripped: number;
      prosePathLeaks: number;
    }
> {
  if (opts.operation.kind !== "write_page" && opts.operation.kind !== "append_page") return { handled: false };
  const relPath = compileOperationPath(opts.operation);
  const target = readWikiPageTarget(relPath);
  if (target.kind !== "page" || !isKnowledgePageType(target.type)) return { handled: false };
  const fullPath = join(opts.vaultRoot, ...target.path.split("/"));
  if (!existsSync(fullPath)) return { handled: false };
  if (!await pageHasProse(fullPath)) return { handled: false };

  let incoming = operationIncomingContent(opts.operation);
  if (!opts.llm) {
    const proposedPath = await stageCompileProposal(
      opts.vaultRoot,
      opts.operation,
      opts.now,
      "knowledge-page update requires rewrite LLM",
    );
    return {
      handled: true,
      outcome: "staged-for-review",
      reason: "knowledge-page update requires rewrite LLM",
      proposedPath,
      referencesStripped: 0,
      prosePathLeaks: 0,
    };
  }

  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  let extractionTokensUsed: LLMTokenUsage | undefined;
  let factsExtracted = 0;
  let sessionsScanned = 0;
  if (opts.extractFacts) {
    const extraction = await extractEntityFacts({
      rawText: incoming,
      entity: typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : target.path,
      entityContext: target.path,
      llm: opts.llm,
      maxBytes: opts.maxBytes,
    });
    incoming = extraction.facts.map((fact) => `- ${fact}`).join("\n");
    extractionTokensUsed = extraction.tokensUsed;
    factsExtracted = extraction.facts.length;
    sessionsScanned = 1;
    if (extraction.facts.length === 0) {
      return {
        handled: true,
        outcome: "skipped: no new content",
        extractionTokensUsed,
        factsExtracted,
        sessionsScanned,
        referencesStripped: 0,
        prosePathLeaks: 0,
      };
    }
  }
  try {
    const page = parsePageIR(current, target.path);
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : page.title;
    const sourceFacts = makeSyntheticCompressedFacts(incoming, title, opts.now);
    if (sourceFacts.length === 0) {
      return {
        handled: true,
        outcome: "skipped: no new content",
        extractionTokensUsed,
        factsExtracted,
        sessionsScanned,
        referencesStripped: 0,
        prosePathLeaks: 0,
      };
    }
    const filtered = filterNoiseForPage(title, sourceFacts);
    if (filtered.accepted.length === 0) {
      return {
        handled: true,
        outcome: "skipped: no new content",
        extractionTokensUsed,
        factsExtracted,
        sessionsScanned,
        referencesStripped: 0,
        prosePathLeaks: 0,
      };
    }
    const plan = await planSectionPatches({
      llm: opts.llm,
      page,
      facts: filtered.accepted,
      droppedFacts: filtered.dropped.map((drop) => ({ fact_id: drop.fact_id, reason: drop.reason })),
    });
    let tokensUsed = plan.tokensUsed;
    if (plan.output.section_jobs.length === 0) {
      return {
        handled: true,
        outcome: "skipped: no new content",
        tokensUsed,
        extractionTokensUsed,
        factsExtracted,
        sessionsScanned,
        referencesStripped: 0,
        prosePathLeaks: 0,
      };
    }

    let appliedAnyRewrite = false;
    for (const job of plan.output.section_jobs) {
      const section = page.sections.find((candidate) => candidate.section_id === job.section_id);
      if (!section) throw new Error(`planner referenced unknown section ${job.section_id}`);
      if (sectionHasUnsupportedStructuredBlocks(section.body_blocks)) {
        const reason = `section ${section.section_id} contains structured blocks`;
        const proposedPath = await stageCompileProposal(opts.vaultRoot, opts.operation, opts.now, reason);
        return {
          handled: true,
          outcome: "staged-for-review",
          reason,
          proposedPath,
          tokensUsed,
          extractionTokensUsed,
          factsExtracted,
          sessionsScanned,
          referencesStripped: 0,
          prosePathLeaks: 0,
        };
      }
      const rendered = await renderSectionPatch({
        llm: opts.llm,
        section,
        job,
        facts: filtered.accepted,
      });
      if (rendered.tokensUsed) tokensUsed = addTokenUsage(tokensUsed, rendered.tokensUsed);
      try {
        validateRender(rendered.output, job, section);
      } catch (error) {
        const reason = `section render invalid: ${error instanceof Error ? error.message : String(error)}`;
        const proposedPath = await stageCompileProposal(opts.vaultRoot, opts.operation, opts.now, reason);
        return {
          handled: true,
          outcome: "staged-for-review",
          reason,
          proposedPath,
          tokensUsed,
          extractionTokensUsed,
          factsExtracted,
          sessionsScanned,
          referencesStripped: 0,
          prosePathLeaks: 0,
        };
      }
      const applied = await applyOperation(opts.vaultRoot, compileSectionPatch({
        path: target.path,
        page,
        sectionId: section.section_id,
        bodyHash: section.body_hash,
        replacementBlocks: rendererOutputToBlocks(rendered.output),
      }), opts.now);
      if (!applied.ok) {
        const reason = `knowledge-page section_patch failed: ${applied.reason}`;
        const proposedPath = await stageCompileProposal(opts.vaultRoot, opts.operation, opts.now, reason);
        return {
          handled: true,
          outcome: "staged-for-review",
          reason,
          proposedPath,
          tokensUsed,
          extractionTokensUsed,
          factsExtracted,
          sessionsScanned,
          referencesStripped: 0,
          prosePathLeaks: 0,
        };
      }
      if (applied.outcome === "rewritten") appliedAnyRewrite = true;
    }
    if (!appliedAnyRewrite) {
      return {
        handled: true,
        outcome: "skipped: no new content",
        tokensUsed,
        extractionTokensUsed,
        factsExtracted,
        sessionsScanned,
        referencesStripped: 0,
        prosePathLeaks: 0,
      };
    }
    return {
      handled: true,
      outcome: "rewritten",
      tokensUsed,
      extractionTokensUsed,
      factsExtracted,
      sessionsScanned,
      referencesStripped: 0,
      prosePathLeaks: 0,
    };
  } catch (error) {
    const reason = `knowledge-page section_patch failed: ${error instanceof Error ? error.message : String(error)}`;
    const proposedPath = await stageCompileProposal(opts.vaultRoot, opts.operation, opts.now, reason);
    return {
      handled: true,
      outcome: "staged-for-review",
      reason,
      proposedPath,
      extractionTokensUsed,
      factsExtracted,
      sessionsScanned,
      referencesStripped: 0,
      prosePathLeaks: 0,
    };
  }
}

function makeSyntheticCompressedFacts(incoming: string, title: string, now: Date): CompressedFact[] {
  const observedAt = now.toISOString();
  const text = incoming
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  return [{
    title: `${title} update`,
    facts: [text],
    narrative: text,
    concepts: [title],
    files: [],
    importance: 10,
    sessionId: "compile-update",
    sourceRawPath: "compile-update",
    observedAt,
    compressedAt: observedAt,
  }];
}

function sectionHasUnsupportedStructuredBlocks(blocks: Array<{ type: string }>): boolean {
  return blocks.some((block) =>
    block.type !== "paragraph" &&
    block.type !== "checklist" &&
    block.type !== "list"
  );
}

function operationIncomingContent(operation: Extract<CompileOperation, { kind: "write_page" | "append_page" }>): string {
  return operation.kind === "write_page" ? operation.body : operation.section;
}

function buildKnowledgeNoveltyPrompt(opts: {
  path: string;
  frontmatter: Record<string, unknown>;
  currentBody: string;
  newContent: string;
  maxBytes: number;
}): { ok: true; value: string } | { ok: false; reason: string } {
  const prompt = [
    "Judge whether the new observations contain substantive facts not already stated on this knowledge page.",
    "Return only JSON with this shape: {\"hasNewFacts\": boolean, \"body\": string|null}.",
    "Set hasNewFacts true only when the observations add substantive facts not already stated on the page.",
    "Rewording, reformatting, or restating existing facts is not new.",
    "When hasNewFacts is true, body must be the full updated page body integrating the new facts and preserving existing substantive content.",
    "When hasNewFacts is false, body must be null.",
    "Do not add dated update sections. Do not drop relations, wikilinks, code identifiers, or entity names.",
    `Path: ${opts.path}`,
    "",
    "Current frontmatter:",
    "```json",
    JSON.stringify(opts.frontmatter, null, 2),
    "```",
    "",
    "Current page body:",
    "```markdown",
    opts.currentBody.trim(),
    "```",
    "",
    "New content to integrate:",
    "```markdown",
    opts.newContent.trim(),
    "```",
  ].join("\n");
  if (Buffer.byteLength(prompt, "utf-8") > opts.maxBytes) {
    return { ok: false, reason: "knowledge-page rewrite prompt exceeds byte cap" };
  }
  return { ok: true, value: prompt };
}

function parseNoveltyDecisionResponse(
  content: string,
): { ok: true; decision: { hasNewFacts: boolean; body: string | null } } | { ok: false; reason: string } {
  const json = extractJsonObject(content.trim());
  if (!json) return { ok: false, reason: "knowledge-page novelty LLM returned no JSON decision" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      reason: `knowledge-page novelty JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "knowledge-page novelty decision must be an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record["hasNewFacts"] !== "boolean") {
    return { ok: false, reason: "knowledge-page novelty decision missing hasNewFacts boolean" };
  }
  const hasNewFacts = record["hasNewFacts"];
  const body = record["body"];
  if (body !== null && body !== undefined && typeof body !== "string") {
    return { ok: false, reason: "knowledge-page novelty decision body must be string or null" };
  }
  return {
    ok: true,
    decision: {
      hasNewFacts,
      body: typeof body === "string" ? body : null,
    },
  };
}

function extractJsonObject(content: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(content)?.[1]?.trim();
  if (fenced) return fenced;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return content.slice(start, end + 1);
}

function hasSubstantiveLineChange(previousBody: string, nextBody: string): boolean {
  const previous = new Set(normalizedSubstantiveLines(previousBody));
  const next = new Set(normalizedSubstantiveLines(nextBody));
  if (previous.size !== next.size) return true;
  for (const line of next) {
    if (!previous.has(line)) return true;
  }
  return false;
}

function normalizedSubstantiveLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, "").replace(/\s+/g, " ").toLowerCase())
    .filter((line) => line.length > 0);
}

function addTokenUsage(left: LLMTokenUsage | undefined, right: LLMTokenUsage): LLMTokenUsage {
  return {
    prompt: (left?.prompt ?? 0) + right.prompt,
    completion: (left?.completion ?? 0) + right.completion,
    total: (left?.total ?? 0) + right.total,
  };
}

async function guardRewriteOperation(
  vaultRoot: string,
  operation: Extract<CompileOperation, { kind: "rewrite_page" }>,
  _now: Date,
): Promise<
  | { ok: true; stage: false }
  | { ok: true; stage: true; reason: string }
  | { ok: false; reason: string }
> {
  const relPath = compileOperationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  if (normalizeContent(parsed.body) === normalizeContent(operation.body)) {
    return { ok: true, stage: false };
  }
  const nextFrontmatter = {
    ...parsed.frontmatter,
    ...operation.frontmatter,
  };
  const coverage = assessFactCoverage({
    previousFrontmatter: parsed.frontmatter,
    previousBody: parsed.body,
    nextFrontmatter,
    nextBody: operation.body,
  });
  if (!coverage.ok) {
    return { ok: true, stage: true, reason: "rewrite drops salient anchors - review for content loss" };
  }
  return { ok: true, stage: false };
}

async function steerExistingPageOperation(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date,
): Promise<
  | { stage: false; skipped?: false }
  | { stage: false; skipped: true; converted?: CompileOperationConversion }
  | { stage: true; reason: string }
> {
  if (operation.kind !== "write_page" && operation.kind !== "append_page") return { stage: false };
  const relPath = compileOperationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  if (!existsSync(fullPath)) return { stage: false };
  if (!await pageHasProse(fullPath)) return { stage: false };

  if (operation.kind === "append_page") {
    if (!await appendSectionHasNewContent(fullPath, operation.section)) {
      return { stage: false, skipped: true };
    }
    if (isDatedEventAppend(operation.section)) return { stage: false };
    return { stage: true, reason: "use rewrite_page for existing pages" };
  }

  const section = await dedupeExistingWriteBody(fullPath, operation.body, now);
  if (!section) {
    return { stage: false, skipped: true, converted: "write->append: target already existed" };
  }
  return { stage: true, reason: "use rewrite_page for existing pages" };
}

async function pageHasProse(fullPath: string): Promise<boolean> {
  const current = await readFile(fullPath, "utf-8");
  return normalizeContent(parseFrontmatter(current).body).length > 0;
}

function isDatedEventAppend(section: string): boolean {
  return /^##\s+\d{4}-\d{2}-\d{2}\b/m.test(section.trim());
}

function assessFactCoverage(input: {
  previousFrontmatter: Record<string, unknown>;
  previousBody: string;
  nextFrontmatter: Record<string, unknown>;
  nextBody: string;
}): { ok: true } | { ok: false; missing: string[] } {
  const previousRelationTargets = relationTargets(input.previousFrontmatter);
  const nextRelationTargets = relationTargets(input.nextFrontmatter);
  const previousLinks = wikiLinks(input.previousBody);
  const nextLinks = wikiLinks(input.nextBody);
  const previousCode = codeAnchors(input.previousBody);
  const nextCode = codeAnchors(input.nextBody);
  const previousEntities = entityAnchors(input.previousBody);
  const nextEntities = entityAnchors(input.nextBody);

  const missing = [
    ...missingAnchors(previousRelationTargets, nextRelationTargets, "relation", 0.9),
    ...missingAnchors(previousLinks, nextLinks, "wikilink", 0.9),
    ...missingAnchors(previousCode, nextCode, "code", 0.8),
    ...missingAnchors(previousEntities, nextEntities, "entity", 0.8),
  ];
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function missingAnchors(previous: Set<string>, next: Set<string>, label: string, threshold: number): string[] {
  if (previous.size === 0) return [];
  let kept = 0;
  const missing: string[] = [];
  for (const anchor of previous) {
    if (next.has(anchor)) kept += 1;
    else missing.push(`${label}:${anchor}`);
  }
  return kept / previous.size >= threshold ? [] : missing;
}

function relationTargets(frontmatter: Record<string, unknown>): Set<string> {
  const relations = frontmatter.relations;
  const targets = new Set<string>();
  if (typeof relations !== "object" || relations === null) return targets;
  for (const value of Object.values(relations as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const target = readRelationTarget(item);
      if (target) targets.add(normalizeAnchor(target));
    }
  }
  return targets;
}

function wikiLinks(body: string): Set<string> {
  const links = new Set<string>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const link = match[1]!.split("|")[0]!.trim();
    if (link) links.add(normalizeAnchor(link));
  }
  return links;
}

function codeAnchors(body: string): Set<string> {
  const anchors = new Set<string>();
  const re = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[1]!.trim();
    if (/[\\/._-]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) {
      anchors.add(normalizeAnchor(value));
    }
  }
  return anchors;
}

function entityAnchors(body: string): Set<string> {
  const anchors = new Set<string>();
  const re = /\b(?:[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*|[A-Za-z]+[A-Z][A-Za-z0-9]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripDatedUpdateHeadings(body))) !== null) {
    const value = match[0].trim();
    if (value.length > 2 && !/^I$/.test(value)) anchors.add(normalizeAnchor(value));
  }
  return anchors;
}

function normalizeAnchor(value: string): string {
  return value.replace(/\\/g, "/").replace(/^wiki\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function archivePageVersion(vaultRoot: string, relPath: string, content: string, now: Date): Promise<string> {
  const safeTimestamp = now.toISOString().replace(/[:.]/g, "-");
  const historyRelPath = join("wiki", ".history", ...relPath.split("/"), `${safeTimestamp}.md`);
  const historyFullPath = join(vaultRoot, ...historyRelPath.split(/[\\/]/));
  await mkdir(dirname(historyFullPath), { recursive: true });
  await atomicWrite(historyFullPath, content);
  return historyRelPath.replace(/\\/g, "/");
}

function datedUpdateSection(body: string, now: Date): string {
  return `## ${now.toISOString().slice(0, 10)} update\n\n${body.trim()}`;
}

async function dedupeExistingWriteBody(fullPath: string, body: string, now: Date): Promise<string | null> {
  const current = await readFile(fullPath, "utf-8");
  const parsed = parseFrontmatter(current);
  const newBody = netNewProse(parsed.body, body);
  return newBody ? datedUpdateSection(newBody, now) : null;
}

function netNewProse(existingBody: string, incomingBody: string): string {
  const existingBlocks = new Set(splitBlocks(existingBody).map(normalizeContent));
  const existingLines = new Set(
    existingBody
      .split(/\r?\n/)
      .map(normalizeContent)
      .filter(Boolean),
  );
  const kept: string[] = [];
  for (const block of splitBlocks(stripDatedUpdateHeadings(incomingBody))) {
    const normalizedBlock = normalizeContent(block);
    if (!normalizedBlock || existingBlocks.has(normalizedBlock)) continue;
    if (isSubstantiallyPresent(existingBody, block)) continue;

    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        const normalizedLine = normalizeContent(line);
        return normalizedLine.length > 0
          && !isDatedUpdateHeading(line)
          && !existingLines.has(normalizedLine)
          && !isSubstantiallyPresent(existingBody, line);
      });
    if (lines.length === 0) continue;
    kept.push(lines.join("\n"));
  }
  return kept.join("\n\n").trim();
}

function isSubstantiallyPresent(existingBody: string, incoming: string): boolean {
  const incomingTokens = tokenizeContent(incoming);
  if (incomingTokens.size === 0) return true;
  const candidates = [
    ...splitBlocks(existingBody),
    ...existingBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  ];
  for (const candidate of candidates) {
    const candidateTokens = tokenizeContent(candidate);
    if (candidateTokens.size === 0) continue;
    const overlap = countIntersection(incomingTokens, candidateTokens) / incomingTokens.size;
    if (overlap >= 0.8) return true;
  }
  return false;
}

function tokenizeContent(text: string): Set<string> {
  const normalized = normalizeContent(text);
  if (!normalized) return new Set();
  return new Set(
    normalized
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2),
  );
}

function countIntersection(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
}

function stripDatedUpdateHeadings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isDatedUpdateHeading(line.trim()))
    .join("\n");
}

function isDatedUpdateHeading(line: string): boolean {
  return /^##\s+\d{4}-\d{2}-\d{2}\s+update\b/i.test(line.trim());
}

function normalizeContent(text: string): string {
  return text
    .replace(/^#+\s+/gm, "")
    .replace(/[`*_~[\]()#>:.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function stageCompileProposal(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date,
  reason: string,
): Promise<string> {
  const target = compileOperationPath(operation);
  const slug = kebabCase(basename(target, ".md")) || "compile-proposal";
  const relPath = `wiki/compile-proposed/${slug}.md`;
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  await atomicWrite(
    fullPath,
    serializeFrontmatter(
      {
        type: "references",
        title: `compile proposal: ${target}`,
        created: now.toISOString().slice(0, 10),
        updated: now.toISOString().slice(0, 10),
        status: "active",
        lifecycle: "proposed",
        source: "compile-execute",
        cognitive_type: "semantic",
      },
      [
        `# Compile proposal: ${target}`,
        "",
        `Reason: ${reason}`,
        "",
        "```compile-op",
        JSON.stringify(operation, null, 2),
        "```",
        "",
      ].join("\n"),
    ),
  );
  return relPath;
}

async function appendText(fullPath: string, text: string): Promise<void> {
  const current = existsSync(fullPath) ? await readFile(fullPath, "utf-8") : "";
  await atomicWrite(fullPath, `${current}${text}`);
}

function hasHighConfidence(operation: CompileOperation): boolean {
  if (operation.kind !== "write_page" && operation.kind !== "rewrite_page") return true;
  if (operation.kind === "rewrite_page" && typeof operation.frontmatter?.confidence === "number") {
    return Number.isFinite(operation.frontmatter.confidence) && operation.frontmatter.confidence >= 0.7;
  }
  const relations = operation.frontmatter?.relations;
  if (typeof relations !== "object" || relations === null) return false;
  const derivedFrom = (relations as Record<string, unknown>).derived_from;
  if (!Array.isArray(derivedFrom)) return false;
  const rawRefs = derivedFrom
    .map((item) => readRelationTarget(item))
    .filter((target): target is string => typeof target === "string" && target.startsWith("raw/"));
  return new Set(rawRefs).size >= 2;
}

function normalizeFrontmatter(input: Record<string, unknown>, relPath: string, now: Date): Frontmatter {
  const date = now.toISOString().slice(0, 10);
  return {
    ...input,
    type: typeof input.type === "string" ? input.type as Frontmatter["type"] : "references",
    title: typeof input.title === "string" && input.title.trim().length > 0 ? input.title : basename(relPath, ".md"),
    created: typeof input.created === "string" ? input.created : date,
    updated: date,
    status: input.status === "archived" || input.status === "superseded" ? input.status : "active",
    lifecycle: input.lifecycle === "proposed" ? "proposed" : "consolidated",
    source: "compile-execute",
    cognitive_type: typeof input.cognitive_type === "string" ? input.cognitive_type as Frontmatter["cognitive_type"] : "semantic",
  };
}

function readOperation(value: unknown): CompileOperation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "write_page" && typeof record.path === "string" && typeof record.body === "string") {
    return {
      kind: "write_page",
      path: record.path,
      body: record.body,
      frontmatter: typeof record.frontmatter === "object" && record.frontmatter !== null && !Array.isArray(record.frontmatter)
        ? record.frontmatter as Record<string, unknown>
        : {},
    };
  }
  if (record.kind === "append_page" && typeof record.path === "string" && typeof record.section === "string") {
    return { kind: "append_page", path: record.path, section: record.section };
  }
  if (record.kind === "rewrite_page" && typeof record.path === "string" && typeof record.body === "string") {
    return {
      kind: "rewrite_page",
      path: record.path,
      body: record.body,
      frontmatter: typeof record.frontmatter === "object" && record.frontmatter !== null && !Array.isArray(record.frontmatter)
        ? record.frontmatter as Record<string, unknown>
        : {},
    };
  }
  if (record.kind === "section_patch" && typeof record.path === "string" && typeof record.section_id === "string" && Array.isArray(record.patch)) {
    const patch = readSectionPatch(record.section_id, record.patch);
    if (!patch) return null;
    return {
      kind: "section_patch",
      path: record.path,
      section_id: record.section_id,
      patch,
    };
  }
  if (record.kind === "update_index" && Array.isArray(record.entries)) {
    return {
      kind: "update_index",
      path: typeof record.path === "string" ? record.path : "index.md",
      entries: record.entries.filter((item): item is string => typeof item === "string"),
    };
  }
  if (record.kind === "append_log" && typeof record.line === "string") {
    return {
      kind: "append_log",
      path: typeof record.path === "string" ? record.path : "log.md",
      line: record.line,
    };
  }
  return null;
}

function readSectionPatch(sectionId: string, value: unknown[]): SectionPatch[] | null {
  const patch: SectionPatch[] = [];
  const hashPath = `/sections/${sectionId}/body_hash` as const;
  const blocksPath = `/sections/${sectionId}/body_blocks` as const;
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (record.op === "test" && record.path === hashPath && typeof record.value === "string") {
      patch.push({ op: "test", path: hashPath, value: record.value });
      continue;
    }
    if (record.op === "replace" && record.path === blocksPath && Array.isArray(record.value)) {
      const blocks = record.value.map(readSectionPatchBlock);
      if (blocks.some((block) => block === null)) return null;
      patch.push({ op: "replace", path: blocksPath, value: blocks as Extract<SectionPatch, { op: "replace" }>["value"] });
      continue;
    }
    return null;
  }
  return patch;
}

function readSectionPatchBlock(value: unknown): Extract<SectionPatch, { op: "replace" }>["value"][number] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "paragraph" && typeof record.text === "string") {
    return { type: "paragraph", text: record.text };
  }
  if (record.type === "checklist" && Array.isArray(record.items)) {
    const items = record.items.map(readChecklistItem);
    if (items.length === 0 || items.some((item) => item === null)) return null;
    return { type: "checklist", items: items as Array<{ checked: boolean; text: string }> };
  }
  if (record.type === "list" && typeof record.ordered === "boolean" && Array.isArray(record.items)) {
    const items = record.items.filter((item): item is string => typeof item === "string");
    if (items.length !== record.items.length || items.length === 0) return null;
    return { type: "list", ordered: record.ordered, items };
  }
  return null;
}

function readChecklistItem(value: unknown): { checked: boolean; text: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.checked !== "boolean" || typeof record.text !== "string") return null;
  return { checked: record.checked, text: record.text };
}

export function compileOperationPath(operation: CompileOperation): string {
  switch (operation.kind) {
    case "write_page":
    case "append_page":
    case "rewrite_page":
    case "section_patch":
      return operation.path;
    case "update_index":
      return operation.path ?? "index.md";
    case "append_log":
      return operation.path ?? "log.md";
  }
}

export function isAllowedCompileRelPath(relPath: string): boolean {
  if (relPath.includes("..") || relPath.startsWith("/") || /^[a-z]:/i.test(relPath)) return false;
  return (relPath.startsWith("wiki/") && relPath.endsWith(".md")) || relPath === "index.md" || relPath === "log.md";
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?^-----END [A-Z ]*PRIVATE KEY-----/gm, "[REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]")
    .replace(/\bgh[posru]_[0-9A-Za-z]{36,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/g, "Bearer [REDACTED]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}
