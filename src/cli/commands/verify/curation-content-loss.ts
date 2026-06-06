import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readRelationTarget } from "../../../retrieval/relations.js";
import { parseFrontmatter } from "../../../storage/frontmatter.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const ID = "curation.content-loss";

export type CurationAnchorKind = "relation" | "wikilink" | "code" | "entity";

export interface CurationAnchor {
  kind: CurationAnchorKind;
  anchor: string;
  normalized: string;
}

export interface CurationAnchorCoverage {
  kind: CurationAnchorKind;
  threshold: number;
  blocksContentLoss: boolean;
  previous: CurationAnchor[];
  next: CurationAnchor[];
  missing: CurationAnchor[];
  kept: number;
  ok: boolean;
}

export interface CurationRewriteAnchorAnalysis {
  path: string;
  historyPath: string;
  coverages: CurationAnchorCoverage[];
  risky: boolean;
}

export const curationContentLossCheck: CheckDescriptor = {
  id: ID,
  label: "curation rewrite content-loss guard",
  roles: ["operator", "server"],
  run: checkCurationContentLoss,
};

async function checkCurationContentLoss(ctx: VerifyCheckContext): Promise<VerifyCheckResult> {
  const analyses = await analyzeCurationRewriteAnchors(ctx.vaultRoot);
  if (analyses.length === 0) {
    return pass(ID, "curation content-loss: no rewrite history");
  }

  const risky = analyses.filter((analysis) => analysis.risky).map((analysis) => analysis.path);
  if (risky.length === 0) {
    return pass(ID, "curation content-loss: latest rewrites preserve salient anchors");
  }
  return warn(
    ID,
    `curation content-loss: ${risky.length} page${risky.length === 1 ? "" : "s"} dropped salient rewrite anchors`,
    risky.join(", "),
  );
}

export async function analyzeCurationRewriteAnchors(vaultRoot: string): Promise<CurationRewriteAnchorAnalysis[]> {
  const historyRoot = join(vaultRoot, "wiki", ".history");
  if (!existsSync(historyRoot)) return [];

  const latestByCanonical = new Map<string, string>();
  for (const historyFile of await listMarkdownFiles(historyRoot)) {
    const rel = relative(historyRoot, historyFile).replace(/\\/g, "/");
    const parts = rel.split("/");
    const timestamp = parts.at(-1);
    if (!timestamp?.endsWith(".md")) continue;
    const canonical = parts.slice(0, -1).join("/");
    if (!canonical.startsWith("wiki/") || !canonical.endsWith(".md")) continue;
    const previous = latestByCanonical.get(canonical);
    if (!previous || historyFile.localeCompare(previous) > 0) {
      latestByCanonical.set(canonical, historyFile);
    }
  }

  const analyses: CurationRewriteAnchorAnalysis[] = [];
  for (const [canonical, historyFile] of latestByCanonical) {
    const canonicalPath = join(vaultRoot, ...canonical.split("/"));
    if (!existsSync(canonicalPath)) continue;
    const current = parseFrontmatter(await readFile(canonicalPath, "utf-8"));
    const history = parseFrontmatter(await readFile(historyFile, "utf-8"));
    const coverages = factAnchorCoverage({
      previousFrontmatter: history.frontmatter,
      previousBody: history.body,
      nextFrontmatter: current.frontmatter,
      nextBody: current.body,
    });
    analyses.push({
      path: canonical,
      historyPath: relative(vaultRoot, historyFile).replace(/\\/g, "/"),
      coverages,
      risky: coverages.some((coverage) => coverage.blocksContentLoss && !coverage.ok),
    });
  }
  return analyses.sort((a, b) => a.path.localeCompare(b.path));
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function factAnchorCoverage(input: {
  previousFrontmatter: Record<string, unknown>;
  previousBody: string;
  nextFrontmatter: Record<string, unknown>;
  nextBody: string;
}): CurationAnchorCoverage[] {
  return [
    coverage("relation", relationTargets(input.previousFrontmatter), relationTargets(input.nextFrontmatter), 0.9, true),
    coverage("wikilink", wikiLinks(input.previousBody), wikiLinks(input.nextBody), 0.9, true),
    coverage("code", codeAnchors(input.previousBody), codeAnchors(input.nextBody), 0.8, true),
    // Entity anchors are useful diagnostics, but old structured pages often
    // contributed section labels ("How", "Reasoning", "Alternatives") that
    // should not block narrative-record rewrites by themselves.
    coverage("entity", entityAnchors(input.previousBody), entityAnchors(input.nextBody), 0.8, false),
  ];
}

function coverage(
  kind: CurationAnchorKind,
  previous: CurationAnchor[],
  next: CurationAnchor[],
  threshold: number,
  blocksContentLoss: boolean,
): CurationAnchorCoverage {
  if (previous.length === 0) {
    return { kind, threshold, blocksContentLoss, previous, next, missing: [], kept: 0, ok: true };
  }
  const nextAnchors = new Set(next.map((anchor) => anchor.normalized));
  let kept = 0;
  const missing: CurationAnchor[] = [];
  for (const anchor of previous) {
    if (nextAnchors.has(anchor.normalized)) kept += 1;
    else missing.push(anchor);
  }
  return {
    kind,
    threshold,
    blocksContentLoss,
    previous,
    next,
    missing,
    kept,
    ok: kept / previous.length >= threshold,
  };
}

function relationTargets(frontmatter: Record<string, unknown>): CurationAnchor[] {
  const relations = frontmatter.relations;
  const targets = new Map<string, CurationAnchor>();
  if (typeof relations !== "object" || relations === null) return [];
  for (const value of Object.values(relations as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const target = readRelationTarget(item);
      if (target) addAnchor(targets, "relation", target);
    }
  }
  return Array.from(targets.values());
}

function wikiLinks(body: string): CurationAnchor[] {
  const links = new Map<string, CurationAnchor>();
  const re = /\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const link = match[1]!.split("|")[0]!.trim();
    if (link) addAnchor(links, "wikilink", link);
  }
  return Array.from(links.values());
}

function codeAnchors(body: string): CurationAnchor[] {
  const anchors = new Map<string, CurationAnchor>();
  const re = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[1]!.trim();
    if (/[\\/._-]/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) {
      addAnchor(anchors, "code", value);
    }
  }
  return Array.from(anchors.values());
}

function entityAnchors(body: string): CurationAnchor[] {
  const anchors = new Map<string, CurationAnchor>();
  const re = /\b(?:[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*|[A-Za-z]+[A-Z][A-Za-z0-9]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripDatedUpdateHeadings(body))) !== null) {
    const value = match[0].trim();
    if (value.length > 2 && !/^I$/.test(value)) addAnchor(anchors, "entity", value);
  }
  return Array.from(anchors.values());
}

function stripDatedUpdateHeadings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^##\s+\d{4}-\d{2}-\d{2}\s+update\b/i.test(line.trim()))
    .join("\n");
}

function addAnchor(target: Map<string, CurationAnchor>, kind: CurationAnchorKind, anchor: string): void {
  const normalized = normalizeAnchor(anchor);
  if (!normalized || target.has(normalized)) return;
  target.set(normalized, { kind, anchor, normalized });
}

function normalizeAnchor(value: string): string {
  return value.replace(/\\/g, "/").replace(/^wiki\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}
