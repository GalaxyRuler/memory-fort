import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  parseFrontmatter,
  validateFrontmatter,
  type Frontmatter,
} from "../storage/frontmatter.js";
import { wikiDir } from "../storage/paths.js";

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
  | "draft";

export interface LintIssue {
  category: LintCategory;
  page: string;
  message: string;
  suggestion?: string;
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
      for (const target of targets as unknown[]) {
        if (typeof target !== "string") continue;
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
        for (const target of targets as unknown[]) {
          if (typeof target !== "string") continue;
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
    const confidence = page.frontmatter.confidence;
    if (typeof confidence !== "number") continue;
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
  ];
}
