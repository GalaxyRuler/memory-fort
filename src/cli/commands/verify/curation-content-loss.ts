import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { readRelationTarget } from "../../../retrieval/relations.js";
import { parseFrontmatter } from "../../../storage/frontmatter.js";
import { pass, warn, type CheckDescriptor, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

const ID = "curation.content-loss";

export const curationContentLossCheck: CheckDescriptor = {
  id: ID,
  label: "curation rewrite content-loss guard",
  roles: ["operator", "server"],
  run: checkCurationContentLoss,
};

async function checkCurationContentLoss(ctx: VerifyCheckContext): Promise<VerifyCheckResult> {
  const historyRoot = join(ctx.vaultRoot, "wiki", ".history");
  if (!existsSync(historyRoot)) {
    return pass(ID, "curation content-loss: no rewrite history");
  }

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

  const risky: string[] = [];
  for (const [canonical, historyFile] of latestByCanonical) {
    const canonicalPath = join(ctx.vaultRoot, ...canonical.split("/"));
    if (!existsSync(canonicalPath)) continue;
    const current = parseFrontmatter(await readFile(canonicalPath, "utf-8"));
    const history = parseFrontmatter(await readFile(historyFile, "utf-8"));
    if (!factAnchorsPreserved({
      previousFrontmatter: history.frontmatter,
      previousBody: history.body,
      nextFrontmatter: current.frontmatter,
      nextBody: current.body,
    })) {
      risky.push(canonical);
    }
  }

  if (risky.length === 0) {
    return pass(ID, "curation content-loss: latest rewrites preserve salient anchors");
  }
  return warn(
    ID,
    `curation content-loss: ${risky.length} page${risky.length === 1 ? "" : "s"} dropped salient rewrite anchors`,
    risky.join(", "),
  );
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

function factAnchorsPreserved(input: {
  previousFrontmatter: Record<string, unknown>;
  previousBody: string;
  nextFrontmatter: Record<string, unknown>;
  nextBody: string;
}): boolean {
  return coverageOk(relationTargets(input.previousFrontmatter), relationTargets(input.nextFrontmatter), 0.9)
    && coverageOk(wikiLinks(input.previousBody), wikiLinks(input.nextBody), 0.9)
    && coverageOk(codeAnchors(input.previousBody), codeAnchors(input.nextBody), 0.8)
    && coverageOk(entityAnchors(input.previousBody), entityAnchors(input.nextBody), 0.8);
}

function coverageOk(previous: Set<string>, next: Set<string>, threshold: number): boolean {
  if (previous.size === 0) return true;
  let kept = 0;
  for (const anchor of previous) {
    if (next.has(anchor)) kept += 1;
  }
  return kept / previous.size >= threshold;
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

function stripDatedUpdateHeadings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^##\s+\d{4}-\d{2}-\d{2}\s+update\b/i.test(line.trim()))
    .join("\n");
}

function normalizeAnchor(value: string): string {
  return value.replace(/\\/g, "/").replace(/^wiki\//, "").replace(/\.md$/i, "").trim().toLowerCase();
}
