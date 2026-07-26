import { type PageRelation } from "../hooks/usePageDetail.js";

const WIKI_PATH_PREFIX = "wiki/";
const MARKDOWN_EXTENSION = ".md";
// Reject encoded dots or separators at any percent-encoding depth without decoding.
const ENCODED_UNSAFE_PATH_RE = /%(?:25)*(?:2e|2f|5c)/i;

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
    || ENCODED_UNSAFE_PATH_RE.test(resolvedPath)
  ) {
    return null;
  }

  const pagePath = resolvedPath.slice(WIKI_PATH_PREFIX.length, -MARKDOWN_EXTENSION.length);
  const parts = pagePath.split("/");
  if (
    parts.length < 2
    || parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return null;
  }

  return { category: parts[0]!, slug: parts.slice(1).join("/") };
}
