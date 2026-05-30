import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  runProcedurePromote,
  runProcedureReject,
} from "../cli/commands/procedure.js";
import {
  runThreadPromote,
  runThreadReject,
} from "../cli/commands/thread.js";
import {
  applyOperation,
  compileOperationPath,
  isAllowedCompileRelPath,
  parseCompileOperationBlock,
} from "../compile/execute.js";
import { rebuildIndex } from "../compile/index.js";
import {
  scoreProposalConfidence,
  type ProposalConfidence,
} from "../llm/proposal-confidence.js";
import {
  parseFrontmatter,
  type Frontmatter,
  type TimeRange,
} from "../storage/frontmatter.js";
import {
  proceduresProposedDir,
  threadsProposedDir,
} from "../storage/paths.js";
import { commitVaultChange } from "../sync/commit-vault-change.js";

export type ProposedKind = "thread" | "procedure" | "compile";

export interface ProposedDraftBase {
  slug: string;
  title: string;
  observationCount: number;
  distinctSessions: number;
  confidence: ProposalConfidence;
  prosePreview: string;
  body: string;
}

export interface ProposedThreadDraft extends ProposedDraftBase {
  kind: "thread";
  timeRange: TimeRange | null;
}

export interface ProposedProcedureDraft extends ProposedDraftBase {
  kind: "procedure";
  commandSignature: string[];
  steps: number;
}

export interface ProposedCompileDraft extends ProposedDraftBase {
  kind: "compile";
  targetPath: string | null;
}

export interface ProposedSummary {
  threads: { total: number; high: number; low: number };
  procedures: { total: number; high: number; low: number };
  compile: { total: number; high: number; low: number };
  total: number;
  recentAutoPromoted: number;
}

interface StoredProposalConfidence {
  level?: unknown;
  reasons?: unknown;
  observation_count?: unknown;
  distinct_sessions?: unknown;
}

export async function listProposedThreads(vaultRoot: string): Promise<ProposedThreadDraft[]> {
  const drafts = await readProposedFiles(threadsProposedDir(vaultRoot));
  return drafts.map(({ slug, frontmatter, body }) => {
    const observed = observationPaths(frontmatter, "mentions");
    const observationCount = storedCount(frontmatter, observed.length);
    const distinctSessions = storedSessions(frontmatter, distinctSessionCount(observed));
    return {
      kind: "thread" as const,
      slug,
      title: frontmatter.title || slug,
      observationCount,
      distinctSessions,
      timeRange: frontmatter.time_range ?? null,
      confidence: readStoredConfidence(frontmatter, observationCount, distinctSessions),
      prosePreview: firstParagraph(body),
      body,
    };
  });
}

export async function listProposedProcedures(vaultRoot: string): Promise<ProposedProcedureDraft[]> {
  const drafts = await readProposedFiles(proceduresProposedDir(vaultRoot));
  return drafts.map(({ slug, frontmatter, body }) => {
    const observed = observationPaths(frontmatter, "derived_from");
    const observationCount = storedCount(frontmatter, observed.length);
    const distinctSessions = storedSessions(frontmatter, distinctSessionCount(observed));
    return {
      kind: "procedure" as const,
      slug,
      title: frontmatter.title || slug,
      observationCount,
      distinctSessions,
      commandSignature: extractCommands(body),
      steps: countProcedureSteps(body),
      confidence: readStoredConfidence(frontmatter, observationCount, distinctSessions),
      prosePreview: firstParagraph(body),
      body,
    };
  });
}

export async function listProposedCompile(vaultRoot: string): Promise<ProposedCompileDraft[]> {
  const drafts = await readProposedFiles(join(vaultRoot, "wiki", "compile-proposed"));
  return drafts.map(({ slug, frontmatter, body }) => ({
    kind: "compile" as const,
    slug,
    title: frontmatter.title || slug,
    observationCount: 0,
    distinctSessions: 0,
    confidence: { level: "low" as const, reasons: ["compile execute staged for review"] },
    prosePreview: firstParagraph(body),
    body,
    targetPath: /# Compile proposal:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? null,
  }));
}

export async function loadProposedSummary(vaultRoot: string): Promise<ProposedSummary> {
  const [threads, procedures, compile, recentAutoPromoted] = await Promise.all([
    listProposedThreads(vaultRoot),
    listProposedProcedures(vaultRoot),
    listProposedCompile(vaultRoot),
    countRecentAutoPromoted(vaultRoot),
  ]);
  const threadCounts = confidenceCounts(threads);
  const procedureCounts = confidenceCounts(procedures);
  const compileCounts = confidenceCounts(compile);
  return {
    threads: threadCounts,
    procedures: procedureCounts,
    compile: compileCounts,
    total: threadCounts.total + procedureCounts.total + compileCounts.total,
    recentAutoPromoted,
  };
}

export async function promoteProposedDraft(
  vaultRoot: string,
  kind: ProposedKind,
  slug: string,
): Promise<{ promotedPath: string }> {
  if (kind === "compile") {
    return promoteCompileProposal(vaultRoot, slug);
  }
  const result = kind === "thread"
    ? await runThreadPromote({ vaultRoot, slug })
    : await runProcedurePromote({ vaultRoot, slug });
  return { promotedPath: result.to };
}

export async function rejectProposedDraft(
  vaultRoot: string,
  kind: ProposedKind,
  slug: string,
): Promise<{ rejectedPath: string }> {
  if (kind === "compile") {
    return rejectCompileProposal(vaultRoot, slug);
  }
  const result = kind === "thread"
    ? await runThreadReject({ vaultRoot, slug })
    : await runProcedureReject({ vaultRoot, slug });
  return { rejectedPath: result.deleted };
}

export function parseProposedActionBody(body: unknown): { ok: true; kind: ProposedKind; slug: string } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const kind = record["kind"];
  const slug = record["slug"];
  if (kind !== "thread" && kind !== "procedure" && kind !== "compile") {
    return { ok: false, message: "kind must be thread, procedure, or compile" };
  }
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    return { ok: false, message: "slug must be a kebab-case string" };
  }
  return { ok: true, kind, slug };
}

async function promoteCompileProposal(vaultRoot: string, slug: string): Promise<{ promotedPath: string }> {
  const safeSlug = sanitizeSlug(slug, "compile");
  const proposalPath = `wiki/compile-proposed/${safeSlug}.md`;
  const fullPath = join(vaultRoot, ...proposalPath.split("/"));
  if (!existsSync(fullPath)) {
    throw new Error(`proposed compile not found: ${proposalPath}`);
  }

  const parsed = parseCompileOperationBlock(await readFile(fullPath, "utf-8"));
  if (!parsed.ok) {
    throw new Error(`invalid compile proposal ${proposalPath}: ${parsed.reason}`);
  }
  const promotedPath = compileOperationPath(parsed.operation);
  if (!isAllowedCompileRelPath(promotedPath)) {
    throw new Error(`invalid compile proposal target: ${promotedPath}`);
  }

  const targetExisted = existsSync(join(vaultRoot, ...promotedPath.split("/")));
  const applied = await applyOperation(vaultRoot, parsed.operation);
  if (!applied.ok) {
    throw new Error(`compile proposal apply failed for ${promotedPath}: ${applied.reason}`);
  }
  const indexPath = await maybeRebuildPromotedCompileIndex(vaultRoot, parsed.operation, promotedPath, targetExisted);
  await rm(fullPath);
  await commitVaultChange({
    memoryRoot: vaultRoot,
    paths: [promotedPath, ...(indexPath ? [indexPath] : []), proposalPath],
    message: `promote compile proposal: ${safeSlug}`,
  });
  return { promotedPath };
}

async function rejectCompileProposal(vaultRoot: string, slug: string): Promise<{ rejectedPath: string }> {
  const safeSlug = sanitizeSlug(slug, "compile");
  const rejectedPath = `wiki/compile-proposed/${safeSlug}.md`;
  const fullPath = join(vaultRoot, ...rejectedPath.split("/"));
  if (!existsSync(fullPath)) {
    throw new Error(`proposed compile not found: ${rejectedPath}`);
  }
  await rm(fullPath);
  await commitVaultChange({
    memoryRoot: vaultRoot,
    paths: [rejectedPath],
    message: `reject compile proposal: ${safeSlug}`,
  });
  return { rejectedPath };
}

async function readProposedFiles(
  dir: string,
): Promise<Array<{ slug: string; frontmatter: Frontmatter; body: string }>> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(files.map(async (file) => {
    const parsed = parseFrontmatter(await readFile(join(dir, file), "utf-8"));
    return {
      slug: basename(file, ".md"),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    };
  }));
}

function readStoredConfidence(
  frontmatter: Frontmatter,
  observationCount: number,
  distinctSessions: number,
): ProposalConfidence {
  const stored = asPlainObject(frontmatter["proposal_confidence"]) as StoredProposalConfidence | null;
  const level = stored?.level === "high" || stored?.level === "low" ? stored.level : null;
  const reasons = Array.isArray(stored?.reasons)
    ? stored.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  if (level && reasons.length > 0) return { level, reasons };

  return scoreProposalConfidence({
    grounding: {
      strippedReferenceCount: 0,
      prosePathLeaksCount: 0,
      commandsStripped: [],
    },
    cluster: { observationCount, distinctSessions },
  });
}

function storedCount(frontmatter: Frontmatter, fallback: number): number {
  const stored = asPlainObject(frontmatter["proposal_confidence"]) as StoredProposalConfidence | null;
  return typeof stored?.observation_count === "number" ? stored.observation_count : fallback;
}

function storedSessions(frontmatter: Frontmatter, fallback: number): number {
  const stored = asPlainObject(frontmatter["proposal_confidence"]) as StoredProposalConfidence | null;
  return typeof stored?.distinct_sessions === "number" ? stored.distinct_sessions : fallback;
}

function observationPaths(frontmatter: Frontmatter, relation: "mentions" | "derived_from"): string[] {
  const relations = asPlainObject(frontmatter.relations);
  const value = relations?.[relation];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.startsWith("raw/"))
    : [];
}

function distinctSessionCount(paths: string[]): number {
  return new Set(paths.map((path) => basename(path, ".md"))).size;
}

function firstParagraph(body: string): string {
  const paragraph = body.trimStart()
    .replace(/^# .*(?:\r?\n)+/, "")
    .split(/\r?\n\r?\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0) ?? "";
  return paragraph.length > 300 ? `${paragraph.slice(0, 297)}...` : paragraph;
}

function extractCommands(body: string): string[] {
  const commands = [...body.matchAll(/```(?:bash|powershell|sh)?\r?\n([\s\S]*?)```/g)]
    .map((match) => match[1]?.trim())
    .filter((command): command is string => Boolean(command));
  return commands.slice(0, 5);
}

function countProcedureSteps(body: string): number {
  const section = body.split(/^## Steps\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const matches = section.match(/^\d+\.\s+/gm);
  return matches?.length ?? 0;
}

function confidenceCounts(drafts: Array<{ confidence: ProposalConfidence }>): { total: number; high: number; low: number } {
  const high = drafts.filter((draft) => draft.confidence.level === "high").length;
  return { total: drafts.length, high, low: drafts.length - high };
}

function sanitizeSlug(slug: string, kind: ProposedKind): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`invalid ${kind} slug: ${slug}`);
  }
  return slug;
}

async function maybeRebuildPromotedCompileIndex(
  vaultRoot: string,
  operation: { kind: string; path?: string },
  promotedPath: string,
  targetExisted: boolean,
): Promise<string | null> {
  if (operation.kind !== "write_page" || targetExisted) return null;
  if (!promotedPath.startsWith("wiki/") || !promotedPath.endsWith(".md")) return null;

  const result = await rebuildIndex(vaultRoot);
  return result.changed ? "index.md" : null;
}

async function countRecentAutoPromoted(vaultRoot: string): Promise<number> {
  const auditDir = join(vaultRoot, "wiki", ".audit");
  if (!existsSync(auditDir)) return 0;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const entries = await readdir(auditDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(join(auditDir, entry.name), "utf-8");
    const started = /^started:\s*(.+)$/m.exec(text)?.[1];
    const startedMs = started ? Date.parse(started) : Number.NaN;
    if (Number.isFinite(startedMs) && startedMs < cutoff) continue;
    count += (text.match(/autoPromoted: true/g) ?? []).length;
  }
  return count;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
