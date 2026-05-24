import { type PageRelation } from "../hooks/usePageDetail.js";

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
  if (!resolvedPath.startsWith("wiki/")) return null;
  const parts = resolvedPath.replace(/^wiki\//, "").replace(/\.md$/, "").split("/");
  if (parts.length < 2) return null;
  return { category: parts[0] ?? "", slug: parts.slice(1).join("/") };
}
