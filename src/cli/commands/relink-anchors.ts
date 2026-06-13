import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { archivePageVersion, nextNarrativeFrontmatter, validateNarrativeBody } from "../../compile/synthesize-narrative.js";
import { atomicWrite } from "../../storage/atomic-write.js";
import { parseFrontmatter, serializeFrontmatter } from "../../storage/frontmatter.js";
import { memoryRoot } from "../../storage/paths.js";
import {
  analyzeCurationRewriteAnchors,
  type CurationAnchor,
  type CurationAnchorKind,
  type CurationRewriteAnchorAnalysis,
} from "./verify/curation-content-loss.js";

export type RelinkAnchorsMode = "plan" | "apply";

export interface RelinkAnchorsOptions {
  vaultRoot?: string;
  mode: RelinkAnchorsMode;
  page?: string;
  now?: Date;
}

export interface RelinkAnchorAction {
  kind: "wikilink" | "code";
  anchor: string;
  action: "wrap" | "append";
}

export interface RelinkAnchorNeedsReview {
  kind: CurationAnchorKind;
  anchor: string;
  reason: string;
}

export interface RelinkAnchorPageResult {
  path: string;
  historyPath: string;
  restored: RelinkAnchorAction[];
  needsReview: RelinkAnchorNeedsReview[];
  archivePath?: string;
  skipped?: string;
}

export interface RelinkAnchorsResult {
  mode: RelinkAnchorsMode;
  pages: RelinkAnchorPageResult[];
  report: string;
}

interface PlannedRelink {
  body: string;
  restored: RelinkAnchorAction[];
  needsReview: RelinkAnchorNeedsReview[];
}

export async function runRelinkAnchors(opts: RelinkAnchorsOptions): Promise<RelinkAnchorsResult> {
  const root = opts.vaultRoot ?? memoryRoot();
  const now = opts.now ?? new Date();
  const analyses = (await analyzeCurationRewriteAnchors(root))
    .filter((analysis) => analysis.risky)
    .filter((analysis) => matchesPageFilter(analysis.path, opts.page));
  const pages: RelinkAnchorPageResult[] = [];

  for (const analysis of analyses) {
    const fullPath = join(root, ...analysis.path.split("/"));
    if (!existsSync(fullPath)) continue;
    const current = await readFile(fullPath, "utf-8");
    const parsed = parseFrontmatter(current);
    const plan = planRelink(parsed.body, analysis);

    const result: RelinkAnchorPageResult = {
      path: analysis.path,
      historyPath: analysis.historyPath,
      restored: plan.restored,
      needsReview: plan.needsReview,
    };

    // One unrestorable page must not abort the whole batch — record the
    // reason, leave the page untouched, and continue with the rest.
    if (opts.mode === "apply" && plan.needsReview.length > 3) {
      result.skipped = `${plan.needsReview.length} unplaceable anchors; re-synthesize instead of relinking`;
      pages.push(result);
      continue;
    }

    if (opts.mode === "apply" && plan.restored.length > 0) {
      // Enforce the narrative invariant only for pages that satisfied it
      // before relinking — legacy pages with headings/lists must not be
      // blocked from anchor restoration they don't make any worse.
      const originalValid = validateNarrativeBody(parsed.body).ok;
      const validation = validateNarrativeBody(plan.body);
      if (originalValid && !validation.ok) {
        result.skipped = `would violate narrative invariant: ${validation.reason}`;
        pages.push(result);
        continue;
      }
      const history = await archivePageVersion(root, analysis.path, current, now, parsed.frontmatter);
      await mkdir(dirname(fullPath), { recursive: true });
      await atomicWrite(
        fullPath,
        serializeFrontmatter(
          nextNarrativeFrontmatter(parsed.frontmatter, now, [], history),
          `${plan.body.trim()}\n`,
        ),
      );
      result.archivePath = history.path;
    }

    pages.push(result);
  }

  return {
    mode: opts.mode,
    pages,
    report: formatRelinkAnchorsReport(opts.mode, pages),
  };
}

function planRelink(body: string, analysis: CurationRewriteAnchorAnalysis): PlannedRelink {
  let nextBody = body;
  const restored: RelinkAnchorAction[] = [];
  const needsReview: RelinkAnchorNeedsReview[] = [];

  for (const coverage of analysis.coverages) {
    if (coverage.kind === "wikilink") {
      const appends: CurationAnchor[] = [];
      for (const anchor of coverage.missing) {
        const replacement = wrapPlainWikilink(nextBody, anchor.anchor);
        if (replacement) {
          nextBody = replacement;
          restored.push({ kind: "wikilink", anchor: anchor.anchor, action: "wrap" });
        } else {
          appends.push(anchor);
        }
      }
      if (appends.length > 0) {
        nextBody = appendSentence(
          nextBody,
          `Related anchors retained from the previous version include ${joinHumanList(appends.map((anchor) => `[[${anchor.anchor}]]`))}.`,
        );
        restored.push(...appends.map((anchor) => ({
          kind: "wikilink" as const,
          anchor: anchor.anchor,
          action: "append" as const,
        })));
      }
      continue;
    }

    if (coverage.kind === "code") {
      const appends: CurationAnchor[] = [];
      for (const anchor of coverage.missing) {
        const replacement = wrapPlainCodeAnchor(nextBody, anchor.anchor);
        if (replacement) {
          nextBody = replacement;
          restored.push({ kind: "code", anchor: anchor.anchor, action: "wrap" });
        } else {
          appends.push(anchor);
        }
      }
      if (appends.length > 0) {
        nextBody = appendSentence(
          nextBody,
          `Code anchors retained from the previous version include ${joinHumanList(appends.map((anchor) => `\`${anchor.anchor}\``))}.`,
        );
        restored.push(...appends.map((anchor) => ({
          kind: "code" as const,
          anchor: anchor.anchor,
          action: "append" as const,
        })));
      }
      continue;
    }

    if (coverage.blocksContentLoss && !coverage.ok) {
      needsReview.push(...coverage.missing.map((anchor) => ({
        kind: coverage.kind,
        anchor: anchor.anchor,
        reason: "cannot restore body text mechanically",
      })));
    }
  }

  return { body: nextBody, restored, needsReview };
}

function wrapPlainWikilink(body: string, target: string): string | null {
  const candidates = wikilinkCandidates(target);
  for (const candidate of candidates) {
    const replaced = replaceFirstPlainOccurrence(body, candidate, (match) => `[[${target}|${match}]]`);
    if (replaced) return replaced;
  }
  return null;
}

function wikilinkCandidates(target: string): string[] {
  const leaf = target.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.md$/i, "") ?? target;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  return unique([target, leaf, words].filter((candidate) => candidate.length > 0));
}

function wrapPlainCodeAnchor(body: string, anchor: string): string | null {
  for (const candidate of unique([anchor, anchor.replace(/\\/g, "/"), anchor.replace(/\//g, "\\")])) {
    const replaced = replaceFirstPlainOccurrence(body, candidate, (match) => `\`${match}\``);
    if (replaced) return replaced;
  }
  return null;
}

function replaceFirstPlainOccurrence(
  body: string,
  needle: string,
  replacement: (match: string) => string,
): string | null {
  const ranges = protectedRanges(body);
  const re = new RegExp(escapeRegExp(needle), "giu");
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const index = match.index;
    const value = match[0]!;
    if (ranges.some((range) => index >= range.start && index < range.end)) continue;
    return `${body.slice(0, index)}${replacement(value)}${body.slice(index + value.length)}`;
  }
  return null;
}

function protectedRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const re of [/`[^`\n]+`/gu, /\[\[[^\]\n]+\]\]/gu]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0]!.length });
    }
  }
  return ranges;
}

function appendSentence(body: string, sentence: string): string {
  const trimmed = body.trim();
  return trimmed.length === 0 ? sentence : `${trimmed}\n\n${sentence}`;
}

function matchesPageFilter(path: string, page: string | undefined): boolean {
  if (!page) return true;
  const normalized = page.replace(/\\/g, "/").replace(/^wiki\//, "").replace(/\.md$/i, "").toLowerCase();
  const full = path.replace(/^wiki\//, "").replace(/\.md$/i, "").toLowerCase();
  const slug = full.split("/").at(-1);
  return normalized === full || normalized === slug || path.toLowerCase() === page.toLowerCase();
}

function formatRelinkAnchorsReport(mode: RelinkAnchorsMode, pages: RelinkAnchorPageResult[]): string {
  const lines = [`Relink anchors ${mode}`];
  lines.push(`Pages: ${pages.length}`);
  for (const page of pages) {
    lines.push(`- ${page.path}`);
    if (page.skipped) {
      lines.push(`  skipped: ${page.skipped}`);
      continue;
    }
    lines.push(`  restored: ${page.restored.length}`);
    for (const item of page.restored) {
      lines.push(`    - ${item.kind}:${item.anchor} (${item.action})`);
    }
    lines.push(`  needs_review: ${page.needsReview.length}`);
    for (const item of page.needsReview) {
      lines.push(`    - ${item.kind}:${item.anchor} (${item.reason})`);
    }
    if (page.archivePath) lines.push(`  archived: ${page.archivePath}`);
  }
  return `${lines.join("\n")}\n`;
}

function joinHumanList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
