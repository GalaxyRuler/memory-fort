import { existsSync } from "node:fs";
import { loadWiki, type WikiPage } from "../../curation/checks.js";
import { memoryRoot, wikiDir } from "../../storage/paths.js";

export interface PageOptions {
  noInbound?: boolean;
}

export interface ResolvedRelation {
  key: string;
  target: string;
  resolvedPath: string | null;
  resolvedTitle: string | null;
}

export interface InboundReference {
  fromPath: string;
  fromTitle: string | null;
  via: string;
}

export interface PageResult {
  path: string;
  fullPath: string;
  rendered: string;
  relations: ResolvedRelation[];
  inbound: InboundReference[];
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

interface ResolutionIndex {
  byPath: Map<string, WikiPage>;
  byFilename: Map<string, WikiPage[]>;
}

export async function runPage(
  target: string,
  opts: PageOptions = {},
): Promise<PageResult> {
  memoryRoot();
  const root = wikiDir();
  if (!existsSync(root)) {
    throw new Error(
      `memory page: wiki directory missing at ${root}. Run \`memory init\` first.`,
    );
  }

  const pages = await loadWiki(root);
  const idx = buildResolutionIndex(pages);
  const page = resolveTarget(target, idx);
  const relations = resolveRelations(page, idx);
  const inbound = opts.noInbound ? [] : findInbound(page, pages, idx);

  return {
    path: page.path,
    fullPath: page.fullPath,
    rendered: renderPage(page, relations, inbound, opts.noInbound === true),
    relations,
    inbound,
  };
}

function buildResolutionIndex(pages: WikiPage[]): ResolutionIndex {
  const byPath = new Map<string, WikiPage>();
  const byFilename = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const noExt = page.path.replace(/\.md$/, "");
    byPath.set(noExt, page);
    const filename = noExt.split("/").pop()!;
    const existing = byFilename.get(filename) ?? [];
    existing.push(page);
    byFilename.set(filename, existing);
  }
  return { byPath, byFilename };
}

function resolveTarget(target: string, idx: ResolutionIndex): WikiPage {
  const clean = target.trim().replace(/\.md$/, "");
  const byPath = idx.byPath.get(clean);
  if (byPath) return byPath;

  const matches = idx.byFilename.get(clean) ?? [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const list = matches.map((page) => page.path).sort().join(", ");
    throw new Error(
      `memory page: target "${target}" is ambiguous; matches: ${list}. ` +
        `Disambiguate with a relative path like projects/${clean}.md.`,
    );
  }

  throw new Error(
    `memory page: no wiki page matches "${target}". ` +
      "Try `memory grep <name>` to find candidates.",
  );
}

function resolveLink(target: string, idx: ResolutionIndex): WikiPage | null {
  const clean = target.trim().replace(/\.md$/, "");
  const byPath = idx.byPath.get(clean);
  if (byPath) return byPath;
  const matches = idx.byFilename.get(clean) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function resolveRelations(
  page: WikiPage,
  idx: ResolutionIndex,
): ResolvedRelation[] {
  const relations = page.frontmatter.relations;
  if (!relations || typeof relations !== "object") return [];

  const result: ResolvedRelation[] = [];
  for (const key of Object.keys(relations).sort()) {
    const targets = relations[key];
    if (!Array.isArray(targets)) continue;
    for (const target of targets) {
      if (typeof target !== "string") continue;
      const resolved = resolveLink(target, idx);
      result.push({
        key,
        target,
        resolvedPath: resolved?.path ?? null,
        resolvedTitle:
          typeof resolved?.frontmatter.title === "string"
            ? resolved.frontmatter.title
            : null,
      });
    }
  }
  return result;
}

function findInbound(
  target: WikiPage,
  pages: WikiPage[],
  idx: ResolutionIndex,
): InboundReference[] {
  const inbound: InboundReference[] = [];
  for (const page of pages) {
    if (page.path === target.path) continue;

    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(page.body)) !== null) {
      const resolved = resolveLink(match[1]!, idx);
      if (resolved?.path === target.path) {
        inbound.push({
          fromPath: page.path,
          fromTitle: readTitle(page),
          via: "wikilink",
        });
      }
    }

    const relations = page.frontmatter.relations;
    if (!relations || typeof relations !== "object") continue;
    for (const [key, targets] of Object.entries(relations)) {
      if (!Array.isArray(targets)) continue;
      for (const relTarget of targets) {
        if (typeof relTarget !== "string") continue;
        const resolved = resolveLink(relTarget, idx);
        if (resolved?.path === target.path) {
          inbound.push({
            fromPath: page.path,
            fromTitle: readTitle(page),
            via: `relation:${key}`,
          });
        }
      }
    }
  }

  return inbound.sort(
    (a, b) => a.fromPath.localeCompare(b.fromPath) || a.via.localeCompare(b.via),
  );
}

function renderPage(
  page: WikiPage,
  relations: ResolvedRelation[],
  inbound: InboundReference[],
  noInbound: boolean,
): string {
  const fm = page.frontmatter;
  const title = typeof fm.title === "string" ? fm.title : "?";
  const type = typeof fm.type === "string" ? fm.type : "?";
  const status = typeof fm.status === "string" ? fm.status : "active";
  const confidence =
    typeof fm.confidence === "number" ? String(fm.confidence) : "(unset)";
  const created = renderScalar(fm.created);
  const updated = renderScalar(fm.updated);
  const tags =
    Array.isArray(fm.tags) && fm.tags.length > 0 ? fm.tags.join(", ") : "(none)";
  const header = [
    "================================================================",
    title,
    page.path,
    "================================================================",
    "",
    `Type:       ${type}`,
    `Status:     ${status}`,
    `Confidence: ${confidence}`,
    `Created:    ${created}`,
    `Updated:    ${updated}`,
    `Tags:       ${tags}`,
    "",
    "---- BODY ----",
    "",
  ].join("\n");

  let rendered = `${header}\n${page.body}`;
  if (!rendered.endsWith("\n")) rendered += "\n";
  rendered += [
    "---- RELATIONS ----",
    "",
    renderRelations(relations),
    "",
    "---- INBOUND ----",
    "",
    renderInbound(inbound, noInbound),
  ].join("\n");
  return rendered.replace(/\n*$/, "\n");
}

function renderRelations(relations: ResolvedRelation[]): string {
  if (relations.length === 0) return "(none)";

  const lines: string[] = [];
  const grouped = new Map<string, ResolvedRelation[]>();
  for (const relation of relations) {
    const group = grouped.get(relation.key) ?? [];
    group.push(relation);
    grouped.set(relation.key, group);
  }

  for (const key of [...grouped.keys()].sort()) {
    lines.push(`${key}:`);
    for (const relation of grouped.get(key)!) {
      lines.push(
        `  - ${relation.target} -> ${relation.resolvedPath ?? "[unresolved]"} ` +
          `(${relation.resolvedTitle ?? "?"})`,
      );
    }
  }
  return lines.join("\n");
}

function renderInbound(
  inbound: InboundReference[],
  noInbound: boolean,
): string {
  if (noInbound) return "(skipped — --no-inbound)";
  if (inbound.length === 0) return "(none)";
  return inbound
    .map(
      (ref) =>
        `- ${ref.fromPath} (${ref.fromTitle ?? "?"}) via ${ref.via}`,
    )
    .join("\n");
}

function readTitle(page: WikiPage): string | null {
  return typeof page.frontmatter.title === "string"
    ? page.frontmatter.title
    : null;
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "?";
}
