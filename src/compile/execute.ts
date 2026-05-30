import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { filterWikiReferencesToExisting, stripProsePathLeaksFromText } from "../llm/proposal-grounding.js";
import { readRelationTarget, type SerializedRelationEdge } from "../retrieval/relations.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";
import { type PageType } from "../storage/paths.js";
import { kebabCase, normalizeWikiPagePath } from "../storage/slug.js";

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
}

export interface ApplyCompileOperationsResult {
  applied: string[];
  proposed: string[];
  planned: string[];
  rejected: Array<{ path: string; reason: string }>;
  outcomes: CompileOperationOutcome[];
  referencesStripped: number;
  prosePathLeaks: number;
}

export type CompileOperationOutcomeKind =
  | "created"
  | "appended"
  | "index-updated"
  | "log-appended"
  | "staged-for-review"
  | "merged"
  | "rejected";

export interface CompileOperationOutcome {
  path: string;
  outcome: CompileOperationOutcomeKind;
  reason?: string;
  contentPreserved: boolean;
}

const COMPILE_OPS_RE = /```compile-ops\s*([\s\S]*?)```/m;
const COMPILE_OP_RE = /```compile-op\s*([\s\S]*?)```/m;
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

    if (!hasHighConfidence(grounded.operation)) {
      const reason = preparedOperation.stageReason ?? "low confidence";
      const proposedPath = await stageCompileProposal(opts.vaultRoot, grounded.operation, now, reason);
      result.proposed.push(proposedPath);
      result.outcomes.push({
        path: relPath,
        outcome: "staged-for-review",
        reason,
        contentPreserved: true,
      });
      continue;
    }

    const applied = await applyOperation(opts.vaultRoot, grounded.operation);
    if (applied.ok) {
      result.applied.push(relPath);
      result.outcomes.push({
        path: relPath,
        outcome: applied.outcome,
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

    if (operation.kind !== "write_page" && operation.kind !== "append_page") {
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
  if (operation.kind !== "write_page") {
    return { operation, referencesStripped: 0, prosePathLeaks: 0 };
  }

  const frontmatter = normalizeFrontmatter(operation.frontmatter ?? {}, operation.path, now);
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
        relations: Object.keys(nextRelations).length > 0 ? nextRelations : undefined,
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
): Promise<{ ok: true; outcome: Extract<CompileOperationOutcomeKind, "created" | "appended" | "index-updated" | "log-appended"> } | { ok: false; reason: string }> {
  const relPath = compileOperationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  switch (operation.kind) {
    case "write_page": {
      if (existsSync(fullPath)) return { ok: false, reason: "target already exists" };
      await atomicWrite(fullPath, serializeFrontmatter(operation.frontmatter as Frontmatter, `${operation.body.trim()}\n`));
      return { ok: true, outcome: "created" };
    }
    case "append_page": {
      if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
      const current = await readFile(fullPath, "utf-8");
      const parsed = parseFrontmatter(current);
      await atomicWrite(fullPath, serializeFrontmatter(parsed.frontmatter, `${parsed.body.trimEnd()}\n\n${operation.section.trim()}\n`));
      return { ok: true, outcome: "appended" };
    }
    case "update_index":
      await appendText(fullPath, `${operation.entries.map((entry) => entry.trim()).filter(Boolean).join("\n")}\n`);
      return { ok: true, outcome: "index-updated" };
    case "append_log":
      await appendText(fullPath, `${operation.line.trim()}\n`);
      return { ok: true, outcome: "log-appended" };
  }
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
  if (operation.kind !== "write_page") return true;
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

export function compileOperationPath(operation: CompileOperation): string {
  switch (operation.kind) {
    case "write_page":
    case "append_page":
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
