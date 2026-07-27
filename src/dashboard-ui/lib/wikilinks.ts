import { unified } from "unified";
import remarkParse from "remark-parse";
import { type PageRelation } from "../hooks/usePageDetail.js";

const WIKI_PATH_PREFIX = "wiki/";
const MARKDOWN_EXTENSION = ".md";
const SAFE_WIKI_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const markdownParser = unified().use(remarkParse);

interface MarkdownNode {
  type: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: MarkdownNode[];
}

interface SourceRange {
  start: number;
  end: number;
}

function setStableResolution(map: Map<string, string>, key: string, resolvedPath: string): void {
  const existing = map.get(key);
  if (!existing || resolvedPath < existing) {
    map.set(key, resolvedPath);
  }
}

function replaceProseWikilinks(source: string, resolutionMap: Map<string, string>): string {
  return source.replace(WIKILINK_RE, (_match, target: string) => {
    const cleanTarget = target.trim();
    const resolved = resolutionMap.get(cleanTarget.toLowerCase());
    if (resolved) {
      return `[${cleanTarget}](wiki:${resolved})`;
    }
    return `[${cleanTarget}]`;
  });
}

function collectProseTextRanges(node: MarkdownNode, ranges: SourceRange[]): void {
  if (node.type === "code" || node.type === "inlineCode") return;

  if (node.type === "text") {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (typeof start === "number" && typeof end === "number" && start <= end) {
      ranges.push({ start, end });
    }
    return;
  }

  for (const child of node.children ?? []) {
    collectProseTextRanges(child, ranges);
  }
}

function replaceInProseText(source: string, resolutionMap: Map<string, string>): string {
  const ranges: SourceRange[] = [];
  collectProseTextRanges(markdownParser.parse(source) as MarkdownNode, ranges);

  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    output += replaceProseWikilinks(source.slice(range.start, range.end), resolutionMap);
    cursor = range.end;
  }
  return output + source.slice(cursor);
}

export function preprocessWikilinks(body: string, relations: PageRelation[]): string {
  const explicitTargets = new Map<string, string>();
  const filenameAliases = new Map<string, string>();
  for (const relation of relations) {
    if (!relation.resolvedPath) continue;
    setStableResolution(explicitTargets, relation.target.toLowerCase(), relation.resolvedPath);
    const filename = relation.resolvedPath.split("/").pop()?.replace(/\.md$/, "");
    if (filename) {
      setStableResolution(filenameAliases, filename.toLowerCase(), relation.resolvedPath);
    }
  }

  const resolutionMap = new Map(filenameAliases);
  for (const [target, resolvedPath] of explicitTargets) {
    resolutionMap.set(target, resolvedPath);
  }

  return replaceInProseText(body, resolutionMap);
}

export function wikiPathToRouterParams(resolvedPath: string): { category: string; slug: string } | null {
  if (
    !resolvedPath.startsWith(WIKI_PATH_PREFIX)
    || !resolvedPath.endsWith(MARKDOWN_EXTENSION)
    || resolvedPath.includes("\\")
    || resolvedPath.includes("?")
    || resolvedPath.includes("#")
  ) {
    return null;
  }

  const pagePath = resolvedPath.slice(WIKI_PATH_PREFIX.length, -MARKDOWN_EXTENSION.length);
  const parts = pagePath.split("/");
  if (
    parts.length < 2
    || parts.some((part) => (
      part.length === 0
      || part === "."
      || part.includes("..")
      || !SAFE_WIKI_SEGMENT_RE.test(part)
    ))
  ) {
    return null;
  }

  return { category: parts[0]!, slug: parts.slice(1).join("/") };
}
