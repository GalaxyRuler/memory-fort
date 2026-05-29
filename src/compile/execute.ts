import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { filterWikiReferencesToExisting, stripProsePathLeaksFromText } from "../llm/proposal-grounding.js";
import { readRelationTarget, type SerializedRelationEdge } from "../retrieval/relations.js";
import { atomicWrite } from "../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "../storage/frontmatter.js";

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
  referencesStripped: number;
  prosePathLeaks: number;
}

const COMPILE_OPS_RE = /```compile-ops\s*([\s\S]*?)```/m;

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

export async function applyCompileOperations(
  opts: ApplyCompileOperationsOptions,
): Promise<ApplyCompileOperationsResult> {
  const result: ApplyCompileOperationsResult = {
    applied: [],
    proposed: [],
    planned: [],
    rejected: [],
    referencesStripped: 0,
    prosePathLeaks: 0,
  };
  const now = opts.now ?? new Date();

  for (const operation of opts.operations) {
    const relPath = operationPath(operation);
    if (!isAllowedRelPath(relPath)) {
      result.rejected.push({ path: relPath, reason: "path outside allowed vault targets" });
      continue;
    }
    const grounded = await groundOperation(opts.vaultRoot, operation, now);
    result.referencesStripped += grounded.referencesStripped;
    result.prosePathLeaks += grounded.prosePathLeaks;

    if (opts.plan) {
      result.planned.push(relPath);
      continue;
    }

    if (!hasHighConfidence(grounded.operation)) {
      const proposedPath = await stageCompileProposal(opts.vaultRoot, grounded.operation, now, "low confidence");
      result.proposed.push(proposedPath);
      continue;
    }

    const applied = await applyOperation(opts.vaultRoot, grounded.operation);
    if (applied.ok) result.applied.push(relPath);
    else result.rejected.push({ path: relPath, reason: applied.reason });
  }

  return result;
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

async function applyOperation(
  vaultRoot: string,
  operation: CompileOperation,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const relPath = operationPath(operation);
  const fullPath = join(vaultRoot, ...relPath.split("/"));
  switch (operation.kind) {
    case "write_page": {
      if (existsSync(fullPath)) return { ok: false, reason: "target already exists" };
      await atomicWrite(fullPath, serializeFrontmatter(operation.frontmatter as Frontmatter, `${operation.body.trim()}\n`));
      return { ok: true };
    }
    case "append_page": {
      if (!existsSync(fullPath)) return { ok: false, reason: "target page does not exist" };
      const current = await readFile(fullPath, "utf-8");
      const parsed = parseFrontmatter(current);
      await atomicWrite(fullPath, serializeFrontmatter(parsed.frontmatter, `${parsed.body.trimEnd()}\n\n${operation.section.trim()}\n`));
      return { ok: true };
    }
    case "update_index":
      await appendText(fullPath, `${operation.entries.map((entry) => entry.trim()).filter(Boolean).join("\n")}\n`);
      return { ok: true };
    case "append_log":
      await appendText(fullPath, `${operation.line.trim()}\n`);
      return { ok: true };
  }
}

async function stageCompileProposal(
  vaultRoot: string,
  operation: CompileOperation,
  now: Date,
  reason: string,
): Promise<string> {
  const target = operationPath(operation);
  const slug = basename(target, ".md").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "compile-proposal";
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
    lifecycle: "consolidated",
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

function operationPath(operation: CompileOperation): string {
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

function isAllowedRelPath(relPath: string): boolean {
  if (relPath.includes("..") || relPath.startsWith("/") || /^[a-z]:/i.test(relPath)) return false;
  return (relPath.startsWith("wiki/") && relPath.endsWith(".md")) || relPath === "index.md" || relPath === "log.md";
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]");
}
