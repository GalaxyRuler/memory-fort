import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  parseFrontmatter,
  validateFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import { getConfidenceScore } from "../storage/confidence.js";
import { wikiDir } from "../storage/paths.js";
import { readRelationTarget } from "../retrieval/relations.js";
import { isWikiDotDirectoryPath } from "../retrieval/wiki-paths.js";

export interface WikiPage {
  /** Relative path under wiki/ (e.g. "projects/agentmemory.md"). Forward slashes. */
  path: string;
  /** Absolute path on disk. */
  fullPath: string;
  frontmatter: Frontmatter;
  body: string;
}

export type LintCategory =
  | "frontmatter"
  | "broken-link"
  | "broken-relation"
  | "orphan"
  | "stale"
  | "draft"
  | "superseded-dependent";

export interface LintIssue {
  category: LintCategory;
  page: string;
  message: string;
  suggestion?: string;
}

export type CurationConflictReason =
  | "contradiction"
  | "derived-from-contradiction";

export interface CurationConflictRecord {
  id: string;
  reason: CurationConflictReason;
  pageA?: string;
  pageB?: string;
  dependentPath?: string;
  via?: string[];
  rootContradictionId?: string;
}

export type PruneCandidateCategory =
  | "stale-orphan-low-confidence"
  | "large-raw";

export interface PruneCandidate {
  category: PruneCandidateCategory;
  path: string;
  title: string;
  updated: string | null;
  confidence: number | null;
}

/**
 * Read all Markdown pages below wiki/ from disk. Skips files whose
 * frontmatter fails to parse; malformed-file reporting is a
 * separate lint concern.
 */
export async function loadWiki(rootDir?: string): Promise<WikiPage[]> {
  const root = rootDir ?? wikiDir();
  if (!existsSync(root)) return [];
  const pages: WikiPage[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = relative(root, full).replace(/\\/g, "/");
        if (relDir.split("/")[0] === "archive" || isWikiDotDirectoryPath(`wiki/${relDir}/placeholder`)) {
          continue;
        }
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf-8");
          const { frontmatter, body } = parseFrontmatter(content);
          const rel = relative(root, full).replace(/\\/g, "/");
          pages.push({ path: rel, fullPath: full, frontmatter, body });
        } catch {
          // Malformed pages are handled by a separate filesystem-level check.
        }
      }
    }
  }

  await walk(root);
  return pages;
}

export function checkFrontmatter(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const page of pages) {
    const result = validateFrontmatter(page.frontmatter);
    if (!result.valid) {
      for (const error of result.errors) {
        issues.push({
          category: "frontmatter",
          page: `wiki/${page.path}`,
          message: error,
        });
      }
    }
  }
  return issues;
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

function buildResolutionIndex(pages: WikiPage[]): {
  byPath: Map<string, string>;
  byFilename: Map<string, string | "AMBIGUOUS">;
} {
  const byPath = new Map<string, string>();
  const byFilename = new Map<string, string | "AMBIGUOUS">();
  for (const page of pages) {
    const noExt = page.path.replace(/\.md$/, "");
    byPath.set(noExt, page.path);
    const filename = noExt.split("/").pop()!;
    if (byFilename.has(filename)) {
      byFilename.set(filename, "AMBIGUOUS");
    } else {
      byFilename.set(filename, page.path);
    }
  }
  return { byPath, byFilename };
}

function resolveLink(
  target: string,
  idx: ReturnType<typeof buildResolutionIndex>,
): string | null {
  const clean = target.trim().replace(/\.md$/, "");
  if (idx.byPath.has(clean)) return idx.byPath.get(clean)!;
  const filenameMatch = idx.byFilename.get(clean);
  if (filenameMatch && filenameMatch !== "AMBIGUOUS") return filenameMatch;
  return null;
}

export function checkBrokenLinks(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const idx = buildResolutionIndex(pages);
  for (const page of pages) {
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(page.body)) !== null) {
      const target = match[1]!;
      if (seen.has(target)) continue;
      seen.add(target);
      if (resolveLink(target, idx) === null) {
        issues.push({
          category: "broken-link",
          page: `wiki/${page.path}`,
          message: `[[${target}]] does not resolve to any wiki page`,
        });
      }
    }
  }
  return issues;
}

export function checkBrokenRelations(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const idx = buildResolutionIndex(pages);
  for (const page of pages) {
    const relations = page.frontmatter.relations;
    if (!relations || typeof relations !== "object") continue;
    for (const [key, targets] of Object.entries(
      relations as Record<string, unknown>,
    )) {
      if (!Array.isArray(targets)) continue;
      for (const relationEntry of targets as unknown[]) {
        const target = readRelationTarget(relationEntry);
        if (!target) continue;
        if (resolveLink(target, idx) === null) {
          issues.push({
            category: "broken-relation",
            page: `wiki/${page.path}`,
            message: `relations.${key} references "${target}" which does not exist as a wiki page`,
          });
        }
      }
    }
  }
  return issues;
}

export function checkOrphans(pages: WikiPage[]): LintIssue[] {
  const idx = buildResolutionIndex(pages);
  const inbound = new Map<string, Set<string>>();

  for (const page of pages) {
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(page.body)) !== null) {
      const resolved = resolveLink(match[1]!, idx);
      if (resolved) {
        if (!inbound.has(resolved)) inbound.set(resolved, new Set());
        inbound.get(resolved)!.add(page.path);
      }
    }

    const relations = page.frontmatter.relations;
    if (relations && typeof relations === "object") {
      for (const targets of Object.values(
        relations as Record<string, unknown>,
      )) {
        if (!Array.isArray(targets)) continue;
        for (const relationEntry of targets as unknown[]) {
          const target = readRelationTarget(relationEntry);
          if (!target) continue;
          const resolved = resolveLink(target, idx);
          if (resolved) {
            if (!inbound.has(resolved)) inbound.set(resolved, new Set());
            inbound.get(resolved)!.add(page.path);
          }
        }
      }
    }
  }

  const issues: LintIssue[] = [];
  for (const page of pages) {
    const incoming = inbound.get(page.path);
    if (!incoming || incoming.size === 0) {
      issues.push({
        category: "orphan",
        page: `wiki/${page.path}`,
        message:
          "no inbound [[wikilinks]] or relations references from any other wiki page",
        suggestion:
          "Link from a project / decision / lesson page, OR archive if no longer relevant.",
      });
    }
  }
  return issues;
}

export function checkStale(
  pages: WikiPage[],
  opts: { now?: Date; thresholdDays?: number } = {},
): LintIssue[] {
  const now = opts.now ?? new Date();
  const threshold = opts.thresholdDays ?? 180;
  const cutoff = now.getTime() - threshold * 24 * 60 * 60 * 1000;
  const issues: LintIssue[] = [];

  for (const page of pages) {
    const status = page.frontmatter.status ?? "active";
    if (status !== "active") continue;
    const updated = page.frontmatter.updated;
    if (typeof updated !== "string") continue;
    const timestamp = Date.parse(updated);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < cutoff) {
      const days = Math.floor(
        (now.getTime() - timestamp) / (24 * 60 * 60 * 1000),
      );
      issues.push({
        category: "stale",
        page: `wiki/${page.path}`,
        message: `status: active but updated: ${updated} (${days} days ago)`,
        suggestion:
          "Consider: archive, supersede, or update with current content.",
      });
    }
  }
  return issues;
}

export function checkDrafts(pages: WikiPage[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const page of pages) {
    const status = page.frontmatter.status ?? "active";
    if (status !== "active") continue;
    if (page.frontmatter.confidence === undefined) continue;
    const confidence = getConfidenceScore(page.frontmatter.confidence);
    if (confidence < 0.5) {
      issues.push({
        category: "draft",
        page: `wiki/${page.path}`,
        message: `confidence: ${confidence} - content tentative`,
        suggestion: "Promote to >= 0.5 with evidence, OR mark status: archived.",
      });
    }
  }
  return issues;
}

interface RelationEdge {
  from: string;
  relation: string;
}

function buildInboundRelationIndex(pages: WikiPage[]): Map<string, RelationEdge[]> {
  const idx = buildResolutionIndex(pages);
  const inbound = new Map<string, RelationEdge[]>();

  for (const page of pages) {
    const relations = page.frontmatter.relations;
    if (!relations || typeof relations !== "object") continue;
    for (const [relation, targets] of Object.entries(
      relations as Record<string, unknown>,
    )) {
      if (!Array.isArray(targets)) continue;
      for (const relationEntry of targets) {
        const target = readRelationTarget(relationEntry);
        if (!target) continue;
        const resolved = resolveLink(target, idx);
        if (!resolved) continue;
        const edges = inbound.get(resolved) ?? [];
        edges.push({ from: page.path, relation });
        inbound.set(resolved, edges);
      }
    }
  }

  return inbound;
}

function collectRelationDependents(
  rootPath: string,
  inbound: Map<string, RelationEdge[]>,
  blocked: Set<string> = new Set(),
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  const queue: Array<{ path: string; depth: number; via: string[] }> = [
    { path: rootPath, depth: 0, via: [] },
  ];
  const seen = new Set<string>([rootPath, ...blocked]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 2) continue;

    for (const edge of inbound.get(current.path) ?? []) {
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      const via = [...current.via, `${edge.from}:${edge.relation}`];
      dependents.set(edge.from, via);
      queue.push({ path: edge.from, depth: current.depth + 1, via });
    }
  }

  return dependents;
}

export function checkContradictions(pages: WikiPage[]): CurationConflictRecord[] {
  const idx = buildResolutionIndex(pages);
  const inbound = buildInboundRelationIndex(pages);
  const conflicts: CurationConflictRecord[] = [];
  const seenDirect = new Set<string>();

  for (const page of pages) {
    const targets = page.frontmatter.relations?.["contradicts"];
    if (!Array.isArray(targets)) continue;

    for (const relationEntry of targets) {
      const target = readRelationTarget(relationEntry);
      if (!target) continue;
      const resolved = resolveLink(target, idx);
      if (!resolved) continue;

      const pair = [page.path, resolved].sort().join("\0");
      if (seenDirect.has(pair)) continue;
      seenDirect.add(pair);

      const id = `contradiction:${page.path}:${resolved}`;
      conflicts.push({
        id,
        reason: "contradiction",
        pageA: `wiki/${page.path}`,
        pageB: `wiki/${resolved}`,
      });

      const blocked = new Set([page.path, resolved]);
      const dependents = new Map([
        ...collectRelationDependents(page.path, inbound, blocked),
        ...collectRelationDependents(resolved, inbound, blocked),
      ]);

      for (const [dependentPath, via] of [...dependents.entries()].sort()) {
        conflicts.push({
          id: `${id}:dependent:${dependentPath}`,
          reason: "derived-from-contradiction",
          dependentPath: `wiki/${dependentPath}`,
          via,
          rootContradictionId: id,
        });
      }
    }
  }

  return conflicts;
}

export function checkSupersededDependents(pages: WikiPage[]): LintIssue[] {
  const inbound = buildInboundRelationIndex(pages);
  const issues: LintIssue[] = [];

  for (const page of pages) {
    if ((page.frontmatter.status ?? "active") !== "superseded") continue;
    const dependents = collectRelationDependents(page.path, inbound);
    for (const [dependentPath, via] of [...dependents.entries()].sort()) {
      issues.push({
        category: "superseded-dependent",
        page: `wiki/${dependentPath}`,
        message: `references superseded page wiki/${page.path} via ${via.join(" -> ")}`,
        suggestion:
          "Review the relation chain and update it to the active replacement, or mark the dependent page for review.",
      });
    }
  }

  return issues;
}

export function checkPruneCandidates(
  pages: WikiPage[],
  opts: { now?: Date; staleDays?: number } = {},
): PruneCandidate[] {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? 180;
  const staleCutoff = now.getTime() - staleDays * 24 * 60 * 60 * 1000;
  const orphanPaths = new Set(
    checkOrphans(pages).map((issue) => issue.page.replace(/^wiki\//, "")),
  );
  const candidates: PruneCandidate[] = [];

  for (const page of pages) {
    if (page.frontmatter.type === "crystal" || page.path.startsWith("crystals/")) {
      continue;
    }
    if ((page.frontmatter.status ?? "active") !== "active") continue;
    if (!orphanPaths.has(page.path)) continue;
    if (page.frontmatter.confidence === undefined) continue;
    const confidence = getConfidenceScore(page.frontmatter.confidence);
    if (confidence >= 0.5) continue;
    const updated = page.frontmatter.updated;
    if (typeof updated !== "string") continue;
    const updatedAt = Date.parse(updated);
    if (!Number.isFinite(updatedAt) || updatedAt >= staleCutoff) continue;

    candidates.push({
      category: "stale-orphan-low-confidence",
      path: `wiki/${page.path}`,
      title: page.frontmatter.title,
      updated,
      confidence,
    });
  }

  return candidates.sort((a, b) => a.path.localeCompare(b.path));
}

export function runAllChecks(
  pages: WikiPage[],
  opts: { now?: Date; staleDays?: number } = {},
): LintIssue[] {
  return [
    ...checkFrontmatter(pages),
    ...checkBrokenLinks(pages),
    ...checkBrokenRelations(pages),
    ...checkOrphans(pages),
    ...checkStale(pages, { now: opts.now, thresholdDays: opts.staleDays }),
    ...checkDrafts(pages),
    ...checkSupersededDependents(pages),
  ];
}
