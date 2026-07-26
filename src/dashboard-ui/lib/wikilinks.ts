import { type PageRelation } from "../hooks/usePageDetail.js";

const WIKI_PATH_PREFIX = "wiki/";
const MARKDOWN_EXTENSION = ".md";
const SAFE_WIKI_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function preprocessWikilinks(body: string, relations: PageRelation[]): string {
  const resolutionMap = new Map<string, string>();
  for (const relation of relations) {
    if (!relation.resolvedPath) continue;
    resolutionMap.set(relation.target.toLowerCase(), relation.resolvedPath);
    const filename = relation.resolvedPath.split("/").pop()?.replace(/\.md$/, "");
    if (filename) {
      resolutionMap.set(filename.toLowerCase(), relation.resolvedPath);
    }
  }

  return body.replace(/\[\[([^\]\n]+)\]\]/g, (_match, target: string) => {
    const cleanTarget = target.trim();
    const resolved = resolutionMap.get(cleanTarget.toLowerCase());
    if (resolved) {
      return `[${cleanTarget}](wiki:${resolved})`;
    }
    return `[${cleanTarget}]`;
  });
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
