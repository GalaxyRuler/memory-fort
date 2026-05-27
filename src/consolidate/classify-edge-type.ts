import type { ProposedRelation } from "./runner.js";

export type EdgeType =
  | "mentions"
  | "derived_from"
  | "uses"
  | "supersedes";

export function classifyEdgeType(relation: ProposedRelation): EdgeType {
  if (isPathInSection(relation.relPath, "tools")) return "uses";
  if (isPathInSection(relation.relPath, "crystals")) return "derived_from";
  if (/deprecated|superseded-by/i.test(relation.title)) return "supersedes";
  if (
    relation.source === "bm25" &&
    (isPathInSection(relation.relPath, "decisions") || isPathInSection(relation.relPath, "lessons"))
  ) {
    return "derived_from";
  }
  return "mentions";
}

function isPathInSection(relPath: string, section: string): boolean {
  return relPath.startsWith(`wiki/${section}/`) && relPath.endsWith(".md");
}
